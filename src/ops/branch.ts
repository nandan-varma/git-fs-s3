import git from "isomorphic-git";
import { GitInvalidRequestError } from "../git-errors.js";
import { isSafeBranchName } from "../refs.js";
import type { Repo } from "./types.js";

export interface Branch {
	name: string;
	commit: string;
	isDefault: boolean;
}

/**
 * Defense in depth for every branch-name argument below: `git.deleteBranch`
 * and raw resolveRef/writeRef reads don't validate ref names internally the
 * way `git.branch` does (see refs.ts) — guard at the point the primitives are
 * actually called, not just at an API boundary far above.
 */
export function assertSafeBranchName(name: string): void {
	if (!isSafeBranchName(name)) {
		throw new GitInvalidRequestError(`Invalid branch name: ${name}`);
	}
}

/** All branches with their tip commits; [] for an empty repository. */
export async function listBranches(repo: Repo): Promise<Branch[]> {
	try {
		const [branches, currentBranch] = await Promise.all([
			git.listBranches(repo),
			git.currentBranch({ ...repo, fullname: false }).catch(() => null),
		]);

		return Promise.all(
			branches.map(async (branch) => ({
				name: branch,
				commit: await git.resolveRef({ ...repo, ref: `refs/heads/${branch}` }),
				isDefault: branch === currentBranch,
			})),
		);
	} catch (err: unknown) {
		if ((err as { code?: string }).code === "NotFoundError") return [];
		throw err;
	}
}

/** Create `name` pointing at the tip of `startPoint` (no checkout). */
export async function createBranchFrom(
	repo: Repo,
	name: string,
	startPoint = "main",
): Promise<void> {
	assertSafeBranchName(name);
	assertSafeBranchName(startPoint);
	const object = await git.resolveRef({
		...repo,
		ref: `refs/heads/${startPoint}`,
	});
	await git.branch({ ...repo, ref: name, checkout: false, object });
}

/** Delete a branch ref (validated — deleteBranch has no internal ref check). */
export async function deleteBranchByName(
	repo: Repo,
	name: string,
): Promise<void> {
	assertSafeBranchName(name);
	await git.deleteBranch({ ...repo, ref: name });
}

/** Throws (NotFoundError) unless the branch resolves. */
export async function assertBranchExists(
	repo: Repo,
	name: string,
): Promise<void> {
	assertSafeBranchName(name);
	await git.resolveRef({ ...repo, ref: `refs/heads/${name}` });
}
