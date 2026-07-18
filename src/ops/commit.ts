import git from "isomorphic-git";
import { assertSafeBranchName } from "./branch.js";
import { deleteFromTree, upsertTree } from "./tree.js";
import type { Repo } from "./types.js";

export interface CommitAuthor {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset: number;
}

/** An author stamped with the current time. */
export function authorNow(name: string, email: string): CommitAuthor {
	return {
		name,
		email,
		timestamp: Math.floor(Date.now() / 1000),
		timezoneOffset: 0,
	};
}

/**
 * Write a commit directly to a bare repository — no worktree, no checkout.
 * `buildTree` receives the parent commit's tree oid (undefined on an empty
 * repo / unborn branch) and returns the new root tree oid; this function
 * writes the commit object and force-updates `refs/heads/<branch>`.
 *
 * Serialize concurrent writers externally (a per-repo lock): the
 * resolve-ref → write-ref sequence is not atomic on object storage.
 */
export async function writeCommitToBare(
	repo: Repo,
	options: {
		branch: string;
		message: string;
		author: CommitAuthor;
		buildTree: (parentTreeOid: string | undefined) => Promise<string>;
	},
): Promise<string> {
	assertSafeBranchName(options.branch);
	let parentOid: string | undefined;
	let parentTreeOid: string | undefined;
	try {
		parentOid = await git.resolveRef({
			...repo,
			ref: `refs/heads/${options.branch}`,
		});
		const { commit } = await git.readCommit({ ...repo, oid: parentOid });
		parentTreeOid = commit.tree;
	} catch (err) {
		if ((err as { code?: string })?.code !== "NotFoundError") {
			throw err;
		}
		// empty repo — first commit
	}
	const treeOid = await options.buildTree(parentTreeOid);
	const commitOid = await git.writeCommit({
		...repo,
		commit: {
			message: options.message,
			tree: treeOid,
			parent: parentOid ? [parentOid] : [],
			author: options.author,
			committer: options.author,
		},
	});
	await git.writeRef({
		...repo,
		ref: `refs/heads/${options.branch}`,
		value: commitOid,
		force: true,
	});
	return commitOid;
}

/**
 * Commit a set of files onto a branch, straight to the bare repo. Each blob
 * is written to its own content-addressed key — no shared state between
 * files, so they're written in parallel.
 */
export function commitFilesToBare(
	repo: Repo,
	options: {
		branch: string;
		message: string;
		author: CommitAuthor;
		files: Array<{ path: string; content: string | Uint8Array }>;
	},
): Promise<string> {
	return writeCommitToBare(repo, {
		branch: options.branch,
		message: options.message,
		author: options.author,
		buildTree: async (parentTreeOid) => {
			const blobs = new Map<string, string>();
			await Promise.all(
				options.files.map(async (file) => {
					const content =
						typeof file.content === "string"
							? new TextEncoder().encode(file.content)
							: file.content;
					const oid = await git.writeBlob({ ...repo, blob: content });
					blobs.set(file.path, oid);
				}),
			);
			return upsertTree(repo, parentTreeOid, blobs);
		},
	});
}

/** Commit the removal of one file from a branch, straight to the bare repo. */
export function deleteFileFromBare(
	repo: Repo,
	options: {
		branch: string;
		filePath: string;
		message: string;
		author: CommitAuthor;
	},
): Promise<string> {
	return writeCommitToBare(repo, {
		branch: options.branch,
		message: options.message,
		author: options.author,
		buildTree: async (parentTreeOid) => {
			if (!parentTreeOid) {
				throw new Error(`Branch ${options.branch} is empty`);
			}
			return deleteFromTree(repo, parentTreeOid, options.filePath);
		},
	});
}
