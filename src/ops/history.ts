import git from "isomorphic-git";
import {
	GitObjectNotFoundError,
	GitPathNotFoundError,
	GitRefNotFoundError,
} from "../git-errors.js";
import { qualifyBranchRef } from "../refs.js";
import { findTreeEntry, listTreeEntries, type TreeEntry } from "./tree.js";
import { type OpsHooks, type Repo, runStep } from "./types.js";

/** How far back history walks look by default (commit count). */
export const HISTORY_WALK_DEPTH = 400;

export interface GitIdentity {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset: number;
}

export interface CommitInfo {
	oid: string;
	commit: {
		message: string;
		tree: string;
		parent: string[];
		author: GitIdentity;
		committer: GitIdentity;
	};
	payload: string;
}

/** The display summary of a commit (history lists, "last commit" columns). */
export interface CommitSummary {
	sha: string;
	message: string;
	authorName: string;
	authorEmail: string;
	/** ISO 8601 author date. */
	createdAt: string;
}

export function summarizeCommit(commit: CommitInfo): CommitSummary {
	return {
		sha: commit.oid,
		message: commit.commit.message.trim(),
		authorName: commit.commit.author.name,
		authorEmail: commit.commit.author.email,
		createdAt: new Date(commit.commit.author.timestamp * 1000).toISOString(),
	};
}

const isNotFound = (err: unknown) =>
	(err as { code?: string } | null)?.code === "NotFoundError";

/**
 * A ref that doesn't resolve is an expected condition (empty repo, unborn
 * branch) each caller handles. An object missing *underneath* a resolved ref
 * means storage is inconsistent — raised as GitObjectNotFoundError so it is
 * never mistaken for "empty".
 */
function wrapMissingObject<T>(
	promise: Promise<T>,
	context: string,
): Promise<T> {
	return promise.catch((err: unknown) => {
		if (isNotFound(err)) {
			throw new GitObjectNotFoundError(
				`Git data for ${context} is missing from storage`,
			);
		}
		throw err;
	});
}

/** The commit a branch name, full ref or sha points at; GitRefNotFoundError if none. */
async function resolveRefOid(repo: Repo, ref: string): Promise<string> {
	try {
		return await git.resolveRef({ ...repo, ref: qualifyBranchRef(ref) });
	} catch (err) {
		if (isNotFound(err))
			throw new GitRefNotFoundError(`Ref ${ref} does not exist`);
		throw err;
	}
}

/** Resolve a branch name / full ref / sha to its commit. */
export async function resolveCommit(repo: Repo, ref: string) {
	const oid = await resolveRefOid(repo, ref);
	const { commit } = await wrapMissingObject(
		git.readCommit({ ...repo, oid }),
		`${repo.gitdir} commit ${oid}`,
	);
	return { oid, commit };
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
	ref: string,
	hooks?: OpsHooks,
): Promise<Uint8Array> {
	// A commit, a tree per path segment, then the blob: warm every pack first
	// rather than discovering them one round trip at a time.
	if (hooks?.prefetch) await runStep(hooks, "prefetch", hooks.prefetch);
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

export interface CommitLogOptions {
	ref: string;
	depth?: number;
	/** The ref's commit, when the caller already resolved it (saves a lookup). */
	knownHeadSha?: string;
}

/**
 * The commit chain from a ref, newest first; [] when the ref doesn't exist.
 * Walking is sequential and round-trip-bound on object storage, so the
 * deepest walk seen per head is memoized in `hooks.resultCache` and sliced
 * for shallower requests.
 */
export async function getCommitLog(
	repo: Repo,
	options: CommitLogOptions,
	hooks?: OpsHooks,
): Promise<CommitInfo[]> {
	const { ref } = options;
	const depth = options.depth ?? 50;
	let headSha = options.knownHeadSha;
	if (headSha === undefined) {
		try {
			headSha = await resolveRefOid(repo, ref);
		} catch (err) {
			if (err instanceof GitRefNotFoundError) return [];
			throw err;
		}
	}

	const cacheKey = `commitlog:${repo.gitdir}:${headSha}`;
	const cached = hooks?.resultCache?.get<CommitInfo[]>(cacheKey);
	const fullyWalked = cached?.at(-1)?.commit.parent.length === 0;
	if (cached && (cached.length >= depth || fullyWalked)) {
		hooks?.onNote?.(`getCommitLog: cache hit ${cacheKey} (depth=${depth})`);
		return cached.slice(0, depth);
	}
	hooks?.onNote?.(`getCommitLog: cache miss ${cacheKey} (depth=${depth})`);
	if (hooks?.prefetch) await runStep(hooks, "prefetch", hooks.prefetch);

	const log = await wrapMissingObject(
		runStep(hooks, `git.log ${ref} depth=${depth}`, () =>
			git.log({ ...repo, ref: headSha, depth }),
		),
		`${repo.gitdir}@${ref} history`,
	);
	const result = log.map(({ oid, commit, payload }) => ({
		oid,
		commit,
		payload: payload ?? "",
	}));
	if (!cached || result.length > cached.length) {
		hooks?.resultCache?.set(cacheKey, result);
	}
	return result;
}

/**
 * List a directory at the tip of a ref. Throws GitRefNotFoundError when the
 * ref doesn't resolve and GitPathNotFoundError when `treePath` doesn't exist.
 * Memoized per head sha.
 */
export async function getTreeFromRef(
	repo: Repo,
	options: { ref: string; treePath?: string },
	hooks?: OpsHooks,
): Promise<TreeEntry[]> {
	const { ref } = options;
	const treePath = options.treePath ?? "";
	const { commit, oid: headSha } = await resolveCommit(repo, ref);

	const cacheKey = `tree:${repo.gitdir}:${headSha}:${treePath}`;
	const cached = hooks?.resultCache?.get<TreeEntry[]>(cacheKey);
	if (cached) {
		hooks?.onNote?.(`getTreeFromRef: cache hit ${cacheKey}`);
		return cached;
	}
	hooks?.onNote?.(`getTreeFromRef: cache miss ${cacheKey}`);
	if (hooks?.prefetch) await runStep(hooks, "prefetch", hooks.prefetch);

	const context = `${repo.gitdir}@${ref}:${treePath || "/"}`;
	const dir = treePath
		? await wrapMissingObject(
				runStep(hooks, `findTreeEntry ${treePath}`, () =>
					findTreeEntry(repo, commit.tree, treePath),
				),
				context,
			)
		: { path: "", type: "tree" as const, oid: commit.tree };
	if (!dir) {
		throw new GitPathNotFoundError(
			`Path "${treePath}" does not exist at ${ref}`,
		);
	}
	const result =
		dir.type === "tree"
			? await wrapMissingObject(
					runStep(hooks, `listTreeEntries ${treePath || "/"}`, () =>
						listTreeEntries(repo, dir.oid, dir.path),
					),
					context,
				)
			: [];
	hooks?.resultCache?.set(cacheKey, result);
	return result;
}

/**
 * A page of commit history from a ref tip; [] when the ref doesn't exist.
 * Pages are slices of {@link getCommitLog}'s memoized walk.
 */
export async function getCommitHistory(
	repo: Repo,
	options: { ref: string; limit?: number; skip?: number },
	hooks?: OpsHooks,
): Promise<CommitInfo[]> {
	const limit = options.limit ?? 50;
	const skip = options.skip ?? 0;
	const log = await getCommitLog(
		repo,
		{ ref: options.ref, depth: limit + skip },
		hooks,
	);
	return log.slice(skip, skip + limit);
}
