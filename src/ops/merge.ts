import git from "isomorphic-git";
import { qualifyBranchRef } from "../refs.js";
import { assertSafeBranchName } from "./branch.js";
import type { Repo } from "./types.js";

export interface MergeAnalysis {
	canMerge: boolean;
	hasConflicts: boolean;
	conflictingFiles: string[];
	fastForward: boolean;
}

/**
 * Cheap pre-merge check: do both branches exist, and is this a fast-forward?
 * `canMerge`/`fastForward` are the only fields this actually determines —
 * `hasConflicts`/`conflictingFiles` are NOT a real content-conflict check
 * (isomorphic-git's `git.merge` doesn't expose a dry-run), they only ever
 * reflect "one of the branches couldn't be resolved" (`canMerge: false`).
 * Real merge conflicts are only discoverable by actually attempting the
 * merge.
 */
export async function analyzeMerge(
	repo: Repo,
	sourceBranch: string,
	targetBranch: string,
): Promise<MergeAnalysis> {
	assertSafeBranchName(sourceBranch);
	assertSafeBranchName(targetBranch);

	try {
		const [sourceOid, targetOid] = await Promise.all([
			git.resolveRef({ ...repo, ref: qualifyBranchRef(sourceBranch) }),
			git.resolveRef({ ...repo, ref: qualifyBranchRef(targetBranch) }),
		]);

		const isDescendant = await git.isDescendent({
			...repo,
			oid: sourceOid,
			ancestor: targetOid,
		});

		return {
			canMerge: true,
			hasConflicts: false,
			conflictingFiles: [],
			fastForward: isDescendant,
		};
	} catch (err) {
		if ((err as { code?: string })?.code !== "NotFoundError") {
			throw err;
		}
		// A branch ref failed to resolve — not a content conflict, just "can't
		// merge because one side doesn't exist." hasConflicts here is a
		// misnomer kept for MergeAnalysis's existing shape; canMerge is the
		// field that actually matters to callers.
		return {
			canMerge: false,
			hasConflicts: true,
			conflictingFiles: [],
			fastForward: false,
		};
	}
}

/**
 * Attempt a fast-forward merge directly against the bare repo: when source is
 * a descendant of target, just move the target ref — no worktree, no new
 * commit. Returns null when the merge is not a fast-forward (callers fall
 * back to a real three-way merge, which needs a worktree). Serialize with a
 * per-repo lock: resolve → writeRef is not atomic.
 */
export async function fastForwardMerge(
	repo: Repo,
	sourceBranch: string,
	targetBranch: string,
): Promise<{ success: true; commitSha: string } | null> {
	assertSafeBranchName(sourceBranch);
	assertSafeBranchName(targetBranch);
	const [sourceOid, targetOid] = await Promise.all([
		git.resolveRef({ ...repo, ref: `refs/heads/${sourceBranch}` }),
		git.resolveRef({ ...repo, ref: `refs/heads/${targetBranch}` }),
	]);
	const isFF = await git.isDescendent({
		...repo,
		oid: sourceOid,
		ancestor: targetOid,
	});
	if (!isFF) return null;
	await git.writeRef({
		...repo,
		ref: `refs/heads/${targetBranch}`,
		value: sourceOid,
		force: true,
	});
	return { success: true, commitSha: sourceOid };
}
