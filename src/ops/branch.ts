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

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Resolve a fully-qualified ref's oid with one read instead of isomorphic-
 * git's own `resolveRef`, which does a stat *then* a read for a loose ref
 * (two round trips against object storage) — wasteful specifically here,
 * where the caller already knows the ref exists (it came from a directory
 * listing moments earlier). Reads the loose file directly and falls back to
 * `git.resolveRef` only when that doesn't pan out (packed-refs, or anything
 * else the plain-loose-file assumption doesn't cover), so correctness for
 * those cases is unchanged — this only removes the redundant round trip on
 * the common path.
 */
export async function resolveLooseRefFast(
	repo: Repo,
	ref: string,
): Promise<string> {
	// Repo.fs is typed as isomorphic-git's own fs union (promise- or
	// callback-based) since that's what git.readTree's signature allows, but
	// every fs this package actually constructs (git-fs.ts) is promise-based
	// — the runtime check just keeps the callback-style branch honest instead
	// of crashing on it.
	const promisesFs = (
		repo.fs as {
			promises?: {
				readFile(path: string, encoding: "utf8"): Promise<string | Uint8Array>;
			};
		}
	).promises;
	if (promisesFs) {
		try {
			const content = await promisesFs.readFile(
				`${repo.gitdir}/${ref}`,
				"utf8",
			);
			const oid = (
				typeof content === "string"
					? content
					: new TextDecoder().decode(content)
			).trim();
			if (FULL_SHA_RE.test(oid)) return oid;
		} catch {
			// Not a loose file (packed-refs, or genuinely absent) — fall through.
		}
	}
	return git.resolveRef({ ...repo, ref });
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
				commit: await resolveLooseRefFast(repo, `refs/heads/${branch}`),
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
	const object = await resolveLooseRefFast(repo, `refs/heads/${startPoint}`);
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
	await resolveLooseRefFast(repo, `refs/heads/${name}`);
}
