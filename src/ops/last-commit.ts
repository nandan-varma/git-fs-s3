import { type CommitInfo, getCommitLog } from "./history.js";
import { findTreeEntry, listTreeEntries } from "./tree.js";
import type { OpsHooks, Repo } from "./types.js";
import { runStep } from "./types.js";

export interface LastCommitInfo {
	sha: string;
	message: string;
	authorName: string;
	authorEmail: string;
	createdAt: string;
}

/**
 * Bounds how far back the history walk looks to resolve "last commit touching
 * this path" for a directory listing. Entries whose last change is older
 * simply show no last-commit info rather than paying an unbounded scan.
 */
const HISTORY_WALK_DEPTH = 400;

/**
 * The walk itself is inherently sequential (each step needs to know what's
 * still "remaining" from the step before), but the tree-object reads that
 * back it are not — each commit's tree oid is already known upfront from the
 * commit log. Prefetching a window of tree reads in parallel turns ~1 network
 * round trip per commit (serialized) into ~1 round trip per window, which is
 * where nearly all of this function's wall-clock time goes on object storage.
 */
const PREFETCH_WINDOW = 24;

function toLastCommitInfo(commit: CommitInfo): LastCommitInfo {
	return {
		sha: commit.oid,
		message: commit.commit.message.trim(),
		authorName: commit.commit.author.name,
		authorEmail: commit.commit.author.email,
		createdAt: new Date(commit.commit.author.timestamp * 1000).toISOString(),
	};
}

/**
 * For each direct child of `treePath` (at the tip of `ref`), find the most
 * recent commit that changed it — the tree view's "last commit" column. Walks
 * history newest-to-oldest, comparing the directory's tree oid
 * commit-to-commit and only descending one level to diff child oids when
 * something under the directory actually changed. Preserve the two-phase
 * structure (parallel prefetch, then sequential resolve) when touching this —
 * the "which entries are still unresolved" state must advance
 * commit-by-commit.
 */
export async function getLastCommitsForTree(
	repo: Repo,
	options: { ref: string; treePath?: string; depth?: number },
	hooks?: OpsHooks,
): Promise<Record<string, LastCommitInfo>> {
	const treePath = options.treePath ?? "";
	const depth = options.depth ?? HISTORY_WALK_DEPTH;
	const commits = await runStep(hooks, `getCommitLog depth=${depth}`, () =>
		getCommitLog(repo, { ref: options.ref, depth }, hooks),
	);
	hooks?.onNote?.(`getLastCommitsForTree: ${commits.length} commits in log`);
	const head = commits[0];
	if (!head) return {};

	const cacheKey = `last-commits:${repo.gitdir}:${head.oid}:${treePath}`;
	const cachedResult =
		hooks?.resultCache?.get<Record<string, LastCommitInfo>>(cacheKey);
	if (cachedResult) {
		hooks?.onNote?.(
			"getLastCommitsForTree: result-cache HIT, skipping history walk",
		);
		return cachedResult;
	}
	hooks?.onNote?.("getLastCommitsForTree: result-cache MISS, walking history");

	const byOid = new Map(commits.map((commit) => [commit.oid, commit]));

	// In a linear history, the "parent tree" resolved at commit[i] is the same
	// tree already resolved as the "current tree" at commit[i-1] — memoize by
	// commit-tree oid (and by resolved dir oid) so each distinct tree is only
	// walked/listed once across the whole scan instead of twice per commit.
	const dirOidByCommitTree = new Map<string, string | null>();
	const childrenByDirOid = new Map<
		string,
		Awaited<ReturnType<typeof listTreeEntries>>
	>();

	async function resolveDirOid(commitTreeOid: string): Promise<string | null> {
		const cached = dirOidByCommitTree.get(commitTreeOid);
		if (cached !== undefined) return cached;
		const entry = await findTreeEntry(repo, commitTreeOid, treePath);
		const dirOid = entry?.type === "tree" ? entry.oid : null;
		dirOidByCommitTree.set(commitTreeOid, dirOid);
		return dirOid;
	}

	async function resolveChildren(dirOid: string | null) {
		if (dirOid === null) return [];
		const cached = childrenByDirOid.get(dirOid);
		if (cached) return cached;
		const children = await listTreeEntries(repo, dirOid, treePath);
		childrenByDirOid.set(dirOid, children);
		return children;
	}

	const headDirOid = await resolveDirOid(head.commit.tree);
	if (headDirOid === null) return {};

	// listTreeEntries is prefixed with treePath so result keys match the full
	// paths that callers key their file listing by.
	const headChildren = await resolveChildren(headDirOid);
	const remaining = new Set(headChildren.map((entry) => entry.path));
	const result: Record<string, LastCommitInfo> = {};

	let commitsWalked = 0;
	let prefetchWindows = 0;
	const walkStart = performance.now();

	outer: for (
		let windowStart = 0;
		windowStart < commits.length && remaining.size > 0;
		windowStart += PREFETCH_WINDOW
	) {
		const windowEnd = Math.min(windowStart + PREFETCH_WINDOW, commits.length);
		// +1 lookahead commit so the last entry's parent tree is already warm too.
		const prefetchEnd = Math.min(windowEnd + 1, commits.length);
		prefetchWindows++;

		// Phase A: resolve this window's directory oid for every commit's tree in
		// parallel (a no-op await when treePath is "" — the root tree oid IS the
		// commit tree, no lookup needed).
		const dirOids = await Promise.all(
			commits
				.slice(windowStart, prefetchEnd)
				.map((commit) => resolveDirOid(commit.commit.tree)),
		);

		// Phase B: resolve children for every distinct directory oid the window
		// touched, in parallel — the actual tree-object read for the common case.
		await Promise.all(
			[...new Set(dirOids)].map((dirOid) => resolveChildren(dirOid)),
		);

		for (let i = windowStart; i < windowEnd; i++) {
			if (remaining.size === 0) break outer;
			const commit = commits[i];
			if (!commit) break outer;
			commitsWalked++;

			const parentSha = commit.commit.parent[0];
			const parentCommit = parentSha ? byOid.get(parentSha) : undefined;
			if (parentSha && !parentCommit) break outer; // walked past the depth cap

			// Already resolved above (or memoized from an earlier window/commit) —
			// these awaits resolve immediately from cache.
			const [dirOid, parentDirOid] = await Promise.all([
				resolveDirOid(commit.commit.tree),
				parentCommit
					? resolveDirOid(parentCommit.commit.tree)
					: Promise.resolve(null),
			]);

			if (dirOid === parentDirOid) continue;

			const [children, parentChildren] = await Promise.all([
				resolveChildren(dirOid),
				resolveChildren(parentDirOid),
			]);
			const childByName = new Map(
				children.map((entry) => [entry.path, entry.oid]),
			);
			const parentChildByName = new Map(
				parentChildren.map((entry) => [entry.path, entry.oid]),
			);

			for (const name of remaining) {
				if (childByName.get(name) !== parentChildByName.get(name)) {
					result[name] = toLastCommitInfo(commit);
				}
			}
			for (const name of Object.keys(result)) {
				remaining.delete(name);
			}
		}
	}

	hooks?.onNote?.(
		`getLastCommitsForTree: walked ${commitsWalked}/${commits.length} commits across ${prefetchWindows} prefetch windows in ${(performance.now() - walkStart).toFixed(1)}ms, ${dirOidByCommitTree.size} unique tree lookups, ${remaining.size} entries never resolved`,
	);

	hooks?.resultCache?.set(cacheKey, result);
	return result;
}
