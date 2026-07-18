import git from "isomorphic-git";
import type { Repo } from "./types.js";

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree";
	oid: string;
	size?: number;
}

const joinPath = (prefix: string, name: string) =>
	prefix ? `${prefix.replace(/\/+$/, "")}/${name}` : name;

/**
 * Build/update a git tree by overlaying new blobs onto an existing tree,
 * returning the new root tree oid. `entries` maps relative paths to blob oids.
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
		byName.set(name, {
			mode: "100644",
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
			const subtreeOid = entry?.type === "tree" ? entry.oid : undefined;
			const newOid = await upsertTree(repo, subtreeOid, subEntries);
			return [dir, newOid] as const;
		}),
	);
	for (const [dir, newOid] of nestedResults) {
		byName.set(dir, { mode: "040000", path: dir, oid: newOid, type: "tree" });
	}
	return git.writeTree({ ...repo, tree: Array.from(byName.values()) });
}

/** Remove a file path from a tree, returning the new root tree oid. */
export async function deleteFromTree(
	repo: Repo,
	treeOid: string,
	filePath: string,
): Promise<string> {
	const existing = (await git.readTree({ ...repo, oid: treeOid })).tree;
	const byName = new Map(existing.map((e) => [e.path, e]));
	const slash = filePath.indexOf("/");
	if (slash === -1) {
		byName.delete(filePath);
	} else {
		const dir = filePath.slice(0, slash);
		const rest = filePath.slice(slash + 1);
		const entry = byName.get(dir);
		if (entry?.type === "tree") {
			const newOid = await deleteFromTree(repo, entry.oid, rest);
			byName.set(dir, { ...entry, oid: newOid });
		}
	}
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
				type: entry.type as "blob" | "tree",
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
		type: entry.type as "blob" | "tree",
		oid: entry.oid,
	}));
}
