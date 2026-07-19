import git from "isomorphic-git";
import { decodeUtf8, hasNullByte, toBase64 } from "../edge-utils.js";
import { GitObjectNotFoundError, GitPathNotFoundError } from "../git-errors.js";
import { qualifyBranchRef } from "../refs.js";
import { findTreeEntry, listTreeEntries, type TreeEntry } from "./tree.js";
import { type OpsHooks, type Repo, runStep } from "./types.js";

/**
 * A resolved ref (branch/commit) not existing is a normal, expected condition
 * (empty repo, unborn branch) and is handled by each caller. An object that
 * fails to resolve *underneath* an already-resolved ref (a tree/blob the
 * stored pack doesn't actually contain) means the repo's storage is
 * inconsistent — surface that distinctly so callers don't render it as
 * "empty" and clients don't see a raw isomorphic-git NotFoundError.
 */
function wrapMissingObject<T>(
	promise: Promise<T>,
	context: string,
): Promise<T> {
	return promise.catch((err: unknown) => {
		if ((err as { code?: string })?.code === "NotFoundError") {
			throw new GitObjectNotFoundError(
				`Git data for ${context} is missing from storage. The repository may need to be re-pushed to repair it.`,
			);
		}
		throw err;
	});
}

const isNotFound = (err: unknown) =>
	(err as { code?: string })?.code === "NotFoundError";

export interface CommitInfo {
	oid: string;
	commit: {
		message: string;
		tree: string;
		parent: string[];
		author: {
			name: string;
			email: string;
			timestamp: number;
			timezoneOffset: number;
		};
		committer: {
			name: string;
			email: string;
			timestamp: number;
			timezoneOffset: number;
		};
	};
	payload: string;
}

/**
 * Resolve a branch name / full ref / sha to its commit. The ref not
 * resolving (unborn branch, genuinely empty repo) and the ref resolving but
 * its commit object being unreadable (storage inconsistency — see
 * `wrapMissingObject` above) are different failures with different meanings,
 * so only the first is left as a raw isomorphic-git NotFoundError for
 * callers to treat as "empty"; the second is wrapped into
 * GitObjectNotFoundError specifically so it can't be mistaken for the first
 * by an `isNotFound`-style check downstream (see getTreeFromRef/getCommitLog).
 */
export async function resolveCommit(repo: Repo, ref: string) {
	const oid = await git.resolveRef({ ...repo, ref: qualifyBranchRef(ref) });
	const result = await wrapMissingObject(
		git.readCommit({ ...repo, oid }),
		`${repo.gitdir} commit ${oid}`,
	);
	return { oid, commit: result.commit };
}

/** Read a blob's bytes by oid. */
export async function getBlob(repo: Repo, sha: string): Promise<Uint8Array> {
	const { blob } = await wrapMissingObject(
		git.readBlob({ ...repo, oid: sha }),
		`${repo.gitdir} blob ${sha}`,
	);
	return blob;
}

/** Read a file's bytes at a ref. Throws GitPathNotFoundError when absent. */
export async function getFileContent(
	repo: Repo,
	filePath: string,
	ref = "main",
): Promise<Uint8Array> {
	const { commit } = await resolveCommit(repo, ref);
	const context = `${repo.gitdir}@${ref}:${filePath}`;
	const entry = await wrapMissingObject(
		findTreeEntry(repo, commit.tree, filePath),
		context,
	);

	if (entry?.type !== "blob") {
		throw new GitPathNotFoundError(`File not found: ${filePath}`);
	}

	const { blob } = await wrapMissingObject(
		git.readBlob({ ...repo, oid: entry.oid }),
		context,
	);
	return blob;
}

/** Read one commit by sha. */
export async function getCommit(repo: Repo, sha: string): Promise<CommitInfo> {
	const result = await wrapMissingObject(
		git.readCommit({ ...repo, oid: sha }),
		`${repo.gitdir} commit ${sha}`,
	);
	return { oid: result.oid, commit: result.commit, payload: result.payload };
}

function isFullyWalked(commits: CommitInfo[]): boolean {
	const last = commits[commits.length - 1];
	return !!last && last.commit.parent.length === 0;
}

export interface CommitLogOptions {
	ref?: string;
	depth?: number;
	/**
	 * Pass the head sha when the caller already resolved `ref` — resolveRef
	 * tries several candidate paths in sequence and misses the first few every
	 * time for a normal branch name, which is pure waste when the sha is known.
	 */
	knownHeadSha?: string;
}

/**
 * The commit chain from a ref, newest first. Walking is inherently sequential
 * (each commit's oid is only discoverable by reading its child first) and
 * network-round-trip-bound against object storage, so the deepest walk seen
 * per head is memoized in `hooks.resultCache` and sliced for shallower or
 * repeated requests — don't bypass this by calling `git.log` directly.
 */
export async function getCommitLog(
	repo: Repo,
	options: CommitLogOptions = {},
	hooks?: OpsHooks,
): Promise<CommitInfo[]> {
	const ref = options.ref ?? "main";
	const depth = options.depth ?? 50;

	let headSha: string;
	if (options.knownHeadSha) {
		headSha = options.knownHeadSha;
	} else {
		try {
			headSha = await git.resolveRef({ ...repo, ref: qualifyBranchRef(ref) });
		} catch (err: unknown) {
			if (isNotFound(err)) return [];
			throw err;
		}
	}

	const cacheKey = `commitlog:${repo.gitdir}:${headSha}`;
	const cached = hooks?.resultCache?.get<CommitInfo[]>(cacheKey);
	if (cached && (cached.length >= depth || isFullyWalked(cached))) {
		hooks?.onNote?.(
			`getCommitLog: result-cache HIT for ${cacheKey} (depth=${depth})`,
		);
		return cached.slice(0, depth);
	}
	hooks?.onNote?.(
		`getCommitLog: result-cache MISS for ${cacheKey} (depth=${depth})`,
	);

	if (hooks?.prefetch && depth >= (hooks.prefetchMinDepth ?? 5)) {
		await runStep(hooks, "prefetch", hooks.prefetch);
	}

	// headSha is already known-good here (resolveRef above succeeded, or the
	// caller passed knownHeadSha) — a NotFoundError from the walk itself means
	// a commit/tree/blob it needs is missing from storage, not that the ref
	// doesn't exist. Unlike the resolveRef catch above, that's not "empty",
	// it's storage inconsistency, so wrapMissingObject turns it into a
	// GitObjectNotFoundError instead of silently returning [] — an empty
	// result here would otherwise get treated as "this branch has no
	// history" by every caller (and, worse, potentially cached as such).
	const commits = await wrapMissingObject(
		runStep(hooks, `git.log ${ref} depth=${depth}`, () =>
			git.log({ ...repo, ref: headSha, depth }),
		),
		`${repo.gitdir}@${ref} history`,
	);
	const result = commits.map((commit) => ({
		oid: commit.oid,
		commit: commit.commit,
		payload: commit.payload || "",
	}));
	if (!cached || result.length > cached.length) {
		hooks?.resultCache?.set(cacheKey, result);
	}
	return result;
}

/** A file at a ref, decoded for display: utf8 text or base64 when binary. */
export async function getFileFromRef(
	repo: Repo,
	filePath: string,
	ref: string,
): Promise<{ content: string; size: number; isBinary: boolean }> {
	const bytes = await getFileContent(repo, filePath, ref);
	const isBinary = hasNullByte(bytes);

	return {
		content: isBinary ? toBase64(bytes) : decodeUtf8(bytes),
		size: bytes.length,
		isBinary,
	};
}

/**
 * List a directory at the tip of a ref. Returns [] for an empty repo/unborn
 * branch; throws GitPathNotFoundError when `treePath` doesn't exist. Results
 * are memoized per head sha (auto-invalidates on push).
 */
export async function getTreeFromRef(
	repo: Repo,
	options: { ref?: string; treePath?: string } = {},
	hooks?: OpsHooks,
): Promise<TreeEntry[]> {
	const ref = options.ref ?? "main";
	const treePath = options.treePath ?? "";

	let commit: Awaited<ReturnType<typeof resolveCommit>>["commit"];
	let headSha: string;
	try {
		const resolved = await resolveCommit(repo, ref);
		commit = resolved.commit;
		headSha = resolved.oid;
	} catch (err: unknown) {
		if (isNotFound(err)) return [];
		throw err;
	}

	const cacheKey = `tree:${repo.gitdir}:${headSha}:${treePath}`;
	const cached = hooks?.resultCache?.get<TreeEntry[]>(cacheKey);
	if (cached) {
		hooks?.onNote?.(`getTreeFromRef: result-cache HIT for ${cacheKey}`);
		return cached;
	}
	hooks?.onNote?.(`getTreeFromRef: result-cache MISS for ${cacheKey}`);

	// Unlike getCommitLog, a tree read has no "depth" to gate on — it always
	// needs at least the head commit's tree object, and (for a non-root path)
	// one object per path segment on top of that, so there's no shallow case
	// where prefetching every pack is wasted bandwidth the way a depth=1
	// commit-log walk can be. Without this, a cache-miss tree read falls
	// through to isomorphic-git's own pack resolution, which probes indexed
	// packs one at a time instead of warming them all in parallel up front —
	// this was previously the slowest of a tree page's parallel queries in
	// production for exactly that reason.
	if (hooks?.prefetch) {
		await runStep(hooks, "prefetch", hooks.prefetch);
	}

	const context = `${repo.gitdir}@${ref}:${treePath || "/"}`;
	let result: TreeEntry[];
	if (!treePath) {
		result = await wrapMissingObject(
			runStep(hooks, "listTreeEntries (root)", () =>
				listTreeEntries(repo, commit.tree),
			),
			context,
		);
	} else {
		const entry = await wrapMissingObject(
			runStep(hooks, `findTreeEntry ${treePath}`, () =>
				findTreeEntry(repo, commit.tree, treePath),
			),
			context,
		);
		if (!entry) {
			throw new GitPathNotFoundError(
				`Path "${treePath}" does not exist at ${ref}`,
			);
		}
		result =
			entry.type !== "tree"
				? []
				: await wrapMissingObject(
						runStep(hooks, `listTreeEntries ${treePath}`, () =>
							listTreeEntries(repo, entry.oid, entry.path),
						),
						context,
					);
	}

	hooks?.resultCache?.set(cacheKey, result);
	return result;
}

/**
 * A page of commit history from a branch tip. Memoized per head sha; builds
 * on {@link getCommitLog}'s walk cache for the underlying chain.
 */
export async function getCommitHistory(
	repo: Repo,
	options: { ref: string; limit?: number; skip?: number },
	hooks?: OpsHooks,
): Promise<CommitInfo[]> {
	const limit = options.limit ?? 50;
	const skip = options.skip ?? 0;
	const headSha = await git
		.resolveRef({ ...repo, ref: qualifyBranchRef(options.ref) })
		.catch(() => null);

	const cacheKey = headSha
		? `commits:${repo.gitdir}:${headSha}:${limit}:${skip}`
		: null;
	if (cacheKey) {
		const cached = hooks?.resultCache?.get<CommitInfo[]>(cacheKey);
		if (cached) {
			hooks?.onNote?.(`getCommitHistory: result-cache HIT for ${cacheKey}`);
			return cached;
		}
	}
	hooks?.onNote?.(
		`getCommitHistory: result-cache MISS for ${cacheKey ?? "(no head)"}`,
	);
	if (!headSha) return [];

	const all = await getCommitLog(
		repo,
		{ ref: options.ref, depth: limit + skip, knownHeadSha: headSha },
		hooks,
	);
	const result = all.slice(skip, skip + limit);

	if (cacheKey) hooks?.resultCache?.set(cacheKey, result);
	return result;
}
