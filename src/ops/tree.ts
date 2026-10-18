import git from "isomorphic-git";
import { GitInvalidRequestError, GitPathNotFoundError } from "../git-errors.js";
import type { Repo } from "./types.js";

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	oid: string;
	size?: number;
}

const joinPath = (prefix: string, name: string) =>
	prefix ? `${prefix.replace(/\/+$/, "")}/${name}` : name;

/** File modes a blob entry can carry; anything else isn't a regular file. */
const BLOB_MODES = new Set(["100644", "100755", "120000"]);

/**
 * Build/update a git tree by overlaying new blobs onto an existing tree,
 * returning the new root tree oid. `entries` maps relative paths to blob oids.
 *
 * An updated file keeps its existing mode (executable bit, symlink); a path
 * that names an existing directory, or runs through an existing file, is
 * rejected rather than silently replacing what's there.
 */
export async function upsertTree(
	repo: Repo,
	treeOid: string | undefined,
	entries: Map<string, string>,
): Promise<string> {
	const existing = treeOid
		? (await git.readTree({ ...repo, oid: treeOid })).tree
		: [];
	const byName = new Map(existing.map((e) => [e.path, e]));
	const direct = new Map<string, string>();
	const nested = new Map<string, Map<string, string>>();
	for (const [filePath, blobOid] of entries) {
		const slash = filePath.indexOf("/");
		if (slash === -1) {
			direct.set(filePath, blobOid);
		} else {
			const dir = filePath.slice(0, slash);
			const rest = filePath.slice(slash + 1);
			if (!nested.has(dir)) nested.set(dir, new Map());
			nested.get(dir)?.set(rest, blobOid);
		}
	}
	for (const [name, blobOid] of direct) {
		const current = byName.get(name);
		if (current && current.type !== "blob") {
			throw new GitInvalidRequestError(`"${name}" is a directory, not a file`);
		}
		byName.set(name, {
			mode: current && BLOB_MODES.has(current.mode) ? current.mode : "100644",
			path: name,
			oid: blobOid,
			type: "blob",
		});
	}
	// Sibling subdirectories are independent subtree writes — no reason to
	// serialize them for multi-file commits touching several directories.
	const nestedResults = await Promise.all(
		Array.from(nested, async ([dir, subEntries]) => {
			const entry = byName.get(dir);
			if (entry && entry.type !== "tree") {
				throw new GitInvalidRequestError(`"${dir}" is a file, not a directory`);
			}
			const subtreeOid = entry?.oid;
			const newOid = await upsertTree(repo, subtreeOid, subEntries);
			return [dir, newOid] as const;
		}),
	);
	for (const [dir, newOid] of nestedResults) {
		byName.set(dir, { mode: "040000", path: dir, oid: newOid, type: "tree" });
	}
	return git.writeTree({ ...repo, tree: Array.from(byName.values()) });
}

/**
 * Remove a file path from a tree, returning the new root tree oid. Throws
 * GitPathNotFoundError when there's no such file; directories left empty
 * are dropped, as git never stores an empty subtree.
 */
export async function deleteFromTree(
	repo: Repo,
	treeOid: string,
	filePath: string,
): Promise<string> {
	const result = await deleteFromSubtree(repo, treeOid, filePath, filePath);
	return result ?? git.writeTree({ ...repo, tree: [] });
}

/** The new subtree oid, or null when removing the file left it empty. */
async function deleteFromSubtree(
	repo: Repo,
	treeOid: string,
	filePath: string,
	fullPath: string,
): Promise<string | null> {
	const existing = (await git.readTree({ ...repo, oid: treeOid })).tree;
	const byName = new Map(existing.map((e) => [e.path, e]));
	const slash = filePath.indexOf("/");
	const name = slash === -1 ? filePath : filePath.slice(0, slash);
	const entry = byName.get(name);
	if (slash === -1) {
		if (entry?.type !== "blob") {
			throw new GitPathNotFoundError(`No such file: ${fullPath}`);
		}
		byName.delete(name);
	} else {
		if (entry?.type !== "tree") {
			throw new GitPathNotFoundError(`No such file: ${fullPath}`);
		}
		const newOid = await deleteFromSubtree(
			repo,
			entry.oid,
			filePath.slice(slash + 1),
			fullPath,
		);
		if (newOid === null) byName.delete(name);
		else byName.set(name, { ...entry, oid: newOid });
	}
	if (byName.size === 0) return null;
	return git.writeTree({ ...repo, tree: Array.from(byName.values()) });
}

/** Resolve a path inside a tree to its entry, or null when absent. */
export async function findTreeEntry(
	repo: Repo,
	rootTreeOid: string,
	treePath: string,
): Promise<TreeEntry | null> {
	if (!treePath) {
		return { path: "", mode: "040000", type: "tree", oid: rootTreeOid };
	}

	const parts = treePath.split("/").filter(Boolean);
	let currentTreeOid = rootTreeOid;
	let currentPath = "";

	for (const [index, part] of parts.entries()) {
		const tree = await git.readTree({ ...repo, oid: currentTreeOid });
		const entry = tree.tree.find((candidate) => candidate.path === part);

		if (!entry) return null;

		currentPath = currentPath ? joinPath(currentPath, entry.path) : entry.path;

		if (index === parts.length - 1) {
			return {
				path: currentPath,
				mode: entry.mode,
				type: entry.type,
				oid: entry.oid,
			};
		}

		if (entry.type !== "tree") return null;

		currentTreeOid = entry.oid;
	}

	return null;
}

/** List a tree's direct entries, with paths prefixed by `prefix`. */
export async function listTreeEntries(
	repo: Repo,
	treeOid: string,
	prefix = "",
): Promise<TreeEntry[]> {
	const tree = await git.readTree({ ...repo, oid: treeOid });

	return tree.tree.map((entry) => ({
		path: prefix ? joinPath(prefix, entry.path) : entry.path,
		mode: entry.mode,
		type: entry.type,
		oid: entry.oid,
	}));
}
