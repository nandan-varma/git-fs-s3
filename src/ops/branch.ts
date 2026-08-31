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

type RecursiveFileLister = {
	listFilesRecursively(dirpath: string): Promise<string[]>;
};

function hasRecursiveFileLister(
	fs: Repo["fs"],
): fs is Repo["fs"] & RecursiveFileLister {
	return (
		typeof fs === "object" &&
		fs !== null &&
		"listFilesRecursively" in fs &&
		typeof (fs as Partial<RecursiveFileLister>).listFilesRecursively ===
			"function"
	);
}

type PromisesFs = {
	readFile(path: string, encoding: "utf8"): Promise<string | Uint8Array>;
};

// Repo.fs is typed as isomorphic-git's own fs union (promise- or
// callback-based) since that's what git.readTree's signature allows, but
// every fs this package actually constructs (git-fs.ts) is promise-based —
// this just keeps the callback-style branch honest instead of crashing on
// it. Shared by every loose-ref fast path below instead of each repeating
// the same cast + presence check.
function getPromisesFs(fs: Repo["fs"]): PromisesFs | null {
	const promises = (fs as { promises?: PromisesFs }).promises;
	return promises ?? null;
}

function decodeFileContent(content: string | Uint8Array): string {
	return typeof content === "string"
		? content
		: new TextDecoder().decode(content);
}

/**
 * Lists loose branch names without isomorphic-git's recursive readdir/stat
 * traversal. Object stores already return only leaf keys in a recursive LIST,
 * so this is one request regardless of branch-name nesting. Ordinary
 * filesystems retain isomorphic-git's implementation and packed refs remain
 * supported there.
 */
async function listLooseBranches(repo: Repo): Promise<string[] | null> {
	if (!hasRecursiveFileLister(repo.fs)) return null;
	const names = await repo.fs.listFilesRecursively(`${repo.gitdir}/refs/heads`);
	return names.filter(isSafeBranchName);
}

/** Read packed branch refs so the object-store fast path preserves Git semantics. */
async function readPackedBranches(repo: Repo): Promise<Map<string, string>> {
	if (!hasRecursiveFileLister(repo.fs)) return new Map();
	const promisesFs = getPromisesFs(repo.fs);
	if (!promisesFs) return new Map();
	try {
		const content = await promisesFs.readFile(
			`${repo.gitdir}/packed-refs`,
			"utf8",
		);
		const refs = new Map<string, string>();
		for (const line of decodeFileContent(content).split("\n")) {
			const match = /^([0-9a-f]{40}) refs\/heads\/(.+)$/i.exec(line);
			if (match?.[1] && match[2] && isSafeBranchName(match[2])) {
				refs.set(match[2], match[1]);
			}
		}
		return refs;
	} catch {
		return new Map();
	}
}

/** Read the symbolic HEAD directly when the object-store fs is available. */
async function getCurrentLooseBranch(repo: Repo): Promise<string | null> {
	if (!hasRecursiveFileLister(repo.fs)) return null;
	const promisesFs = getPromisesFs(repo.fs);
	if (!promisesFs) return null;
	try {
		const content = await promisesFs.readFile(`${repo.gitdir}/HEAD`, "utf8");
		const head = decodeFileContent(content).trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		return match?.[1] && isSafeBranchName(match[1]) ? match[1] : null;
	} catch {
		return null;
	}
}

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
	const promisesFs = getPromisesFs(repo.fs);
	if (promisesFs) {
		try {
			const content = await promisesFs.readFile(
				`${repo.gitdir}/${ref}`,
				"utf8",
			);
			const oid = decodeFileContent(content).trim();
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
		const [looseBranches, looseCurrentBranch, packedBranches] =
			await Promise.all([
				listLooseBranches(repo),
				getCurrentLooseBranch(repo),
				readPackedBranches(repo),
			]);
		const branches =
			looseBranches === null
				? await git.listBranches(repo)
				: [...new Set([...looseBranches, ...packedBranches.keys()])].sort();
		const currentBranch =
			looseBranches === null
				? await git
						.currentBranch({ ...repo, fullname: false })
						.catch(() => null)
				: looseCurrentBranch;

		return Promise.all(
			branches.map(async (branch) => {
				const packedCommit = packedBranches.get(branch);
				return {
					name: branch,
					commit:
						packedCommit && !looseBranches?.includes(branch)
							? packedCommit
							: await resolveLooseRefFast(repo, `refs/heads/${branch}`),
					isDefault: branch === currentBranch,
				};
			}),
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
