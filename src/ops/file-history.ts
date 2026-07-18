import { type CommitInfo, getCommitLog } from "./history.js";
import { findTreeEntry } from "./tree.js";
import type { OpsHooks, Repo } from "./types.js";
import { runStep } from "./types.js";

export interface FileHistoryEntry {
	sha: string;
	message: string;
	authorName: string;
	authorEmail: string;
	createdAt: string;
}

export interface FileHistoryResult {
	entries: FileHistoryEntry[];
	/**
	 * True when the walk hit its depth budget (or the requested `limit`)
	 * before exhausting the branch's full commit chain — there may be older
	 * commits touching this file that a deeper walk would surface.
	 */
	truncated: boolean;
}

/**
 * Default walk bound for a caller that actually wants deep history (a file's
 * "History" tab). Walking the full chain is round-trip-bound on object
 * storage, so cap how far back a single request will look.
 */
export const HISTORY_WALK_DEPTH = 400;

/**
 * Much shallower default for a "latest commit touching this file" banner that
 * only displays `entries[0]` — trades "always finds the true last-touching
 * commit" for "finds it if it's reasonably recent", the right call for a
 * banner with a full History view a click away.
 */
export const BANNER_WALK_DEPTH = 60;

/** Tree reads are prefetched in parallel windows; see getLastCommitsForTree. */
const PREFETCH_WINDOW = 24;

function toEntry(commit: CommitInfo): FileHistoryEntry {
	return {
		sha: commit.oid,
		message: commit.commit.message.trim(),
		authorName: commit.commit.author.name,
		authorEmail: commit.commit.author.email,
		createdAt: new Date(commit.commit.author.timestamp * 1000).toISOString(),
	};
}

/**
 * All commits (newest first) that changed a single file's blob oid, walking
 * the first-parent chain — same approach as getLastCommitsForTree but for one
 * path and collecting every match instead of stopping at the first.
 */
export async function getFileHistory(
	repo: Repo,
	options: {
		ref: string;
		filePath: string;
		limit?: number;
		maxDepth?: number;
	},
	hooks?: OpsHooks,
): Promise<FileHistoryResult> {
	const limit = options.limit ?? 30;
	const maxDepth = options.maxDepth ?? HISTORY_WALK_DEPTH;
	const walkDepth = Math.max(maxDepth, limit);
	const commits = await runStep(hooks, `getCommitLog depth=${walkDepth}`, () =>
		getCommitLog(repo, { ref: options.ref, depth: walkDepth }, hooks),
	);
	const head = commits[0];
	if (!head) return { entries: [], truncated: false };

	const cacheKey = `file-history:${repo.gitdir}:${head.oid}:${options.filePath}:${limit}:${maxDepth}`;
	const cached = hooks?.resultCache?.get<FileHistoryResult>(cacheKey);
	if (cached) {
		hooks?.onNote?.("getFileHistory: result-cache HIT, skipping history walk");
		return cached;
	}
	hooks?.onNote?.("getFileHistory: result-cache MISS, walking history");

	const byOid = new Map(commits.map((commit) => [commit.oid, commit]));

	const oidByCommitTree = new Map<string, string | null>();
	async function resolveOid(commitTreeOid: string): Promise<string | null> {
		const cachedOid = oidByCommitTree.get(commitTreeOid);
		if (cachedOid !== undefined) return cachedOid;
		const entry = await findTreeEntry(repo, commitTreeOid, options.filePath);
		const oid = entry?.type === "blob" ? entry.oid : null;
		oidByCommitTree.set(commitTreeOid, oid);
		return oid;
	}

	const entries: FileHistoryEntry[] = [];
	let truncated = false;

	outer: for (
		let windowStart = 0;
		windowStart < commits.length;
		windowStart += PREFETCH_WINDOW
	) {
		const windowEnd = Math.min(windowStart + PREFETCH_WINDOW, commits.length);
		// +1 lookahead so the last entry's parent tree is already warm too.
		const prefetchEnd = Math.min(windowEnd + 1, commits.length);

		await Promise.all(
			commits
				.slice(windowStart, prefetchEnd)
				.map((commit) => resolveOid(commit.commit.tree)),
		);

		for (let i = windowStart; i < windowEnd; i++) {
			const commit = commits[i];
			if (!commit) break outer;

			const parentSha = commit.commit.parent[0];
			const parentCommit = parentSha ? byOid.get(parentSha) : undefined;
			if (parentSha && !parentCommit) {
				// Walked past the depth cap without reaching this commit's parent —
				// can't tell whether it changed the file; stop and report truncated.
				truncated = true;
				break outer;
			}

			const [oid, parentOid] = await Promise.all([
				resolveOid(commit.commit.tree),
				parentCommit
					? resolveOid(parentCommit.commit.tree)
					: Promise.resolve(null),
			]);

			if (oid !== parentOid) {
				entries.push(toEntry(commit));
				if (entries.length >= limit) {
					truncated = i < commits.length - 1;
					break outer;
				}
			}
		}
	}

	const result = { entries, truncated };
	hooks?.resultCache?.set(cacheKey, result);
	return result;
}
