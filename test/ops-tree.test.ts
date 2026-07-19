import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createGitFs, MemoryObjectStore } from "../src/index.js";
import {
	deleteFromTree,
	findTreeEntry,
	listTreeEntries,
	type Repo,
	upsertTree,
} from "../src/ops/index.js";

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "repo.git", cache: {} };
}

async function writeBlob(repo: Repo, content: string): Promise<string> {
	return git.writeBlob({ ...repo, blob: new TextEncoder().encode(content) });
}

async function readTreePaths(
	repo: Repo,
	treeOid: string,
): Promise<Array<{ path: string; oid: string; type: string }>> {
	const { tree } = await git.readTree({ ...repo, oid: treeOid });
	return tree.map((e) => ({ path: e.path, oid: e.oid, type: e.type }));
}

describe("upsertTree", () => {
	it("creates entries in an empty tree", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "hello");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["file.txt", blobOid]]),
		);

		const entries = await readTreePaths(repo, treeOid);
		expect(entries).toEqual([{ path: "file.txt", oid: blobOid, type: "blob" }]);
	});

	it("adds entries to an existing tree without removing existing entries", async () => {
		const repo = makeRepo();
		const existingBlob = await writeBlob(repo, "existing");
		const baseTree = await upsertTree(
			repo,
			undefined,
			new Map([["existing.txt", existingBlob]]),
		);

		const newBlob = await writeBlob(repo, "new");
		const updatedTree = await upsertTree(
			repo,
			baseTree,
			new Map([["new.txt", newBlob]]),
		);

		const entries = await readTreePaths(repo, updatedTree);
		expect(entries.map((e) => e.path).sort()).toEqual([
			"existing.txt",
			"new.txt",
		]);
	});

	it("creates nested directory structure from flat paths", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "nested");
		const rootTree = await upsertTree(
			repo,
			undefined,
			new Map([["a/b/file.txt", blobOid]]),
		);

		const root = await readTreePaths(repo, rootTree);
		expect(root).toEqual([
			expect.objectContaining({ path: "a", type: "tree" }),
		]);
		const aOid = root[0]?.oid as string;
		const aLevel = await readTreePaths(repo, aOid);
		expect(aLevel).toEqual([
			expect.objectContaining({ path: "b", type: "tree" }),
		]);
		const bOid = aLevel[0]?.oid as string;
		const bLevel = await readTreePaths(repo, bOid);
		expect(bLevel).toEqual([{ path: "file.txt", oid: blobOid, type: "blob" }]);
	});

	it("handles mixed direct + nested entries", async () => {
		const repo = makeRepo();
		const topBlob = await writeBlob(repo, "top");
		const innerBlob = await writeBlob(repo, "inner");
		const rootTree = await upsertTree(
			repo,
			undefined,
			new Map([
				["top.txt", topBlob],
				["sub/inner.txt", innerBlob],
			]),
		);

		const root = await readTreePaths(repo, rootTree);
		expect(root).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "top.txt", type: "blob" }),
				expect.objectContaining({ path: "sub", type: "tree" }),
			]),
		);
	});

	it("updates an existing entry's blob oid", async () => {
		const repo = makeRepo();
		const oldBlob = await writeBlob(repo, "old");
		const baseTree = await upsertTree(
			repo,
			undefined,
			new Map([["file.txt", oldBlob]]),
		);

		const newBlob = await writeBlob(repo, "new");
		const updatedTree = await upsertTree(
			repo,
			baseTree,
			new Map([["file.txt", newBlob]]),
		);

		const entries = await readTreePaths(repo, updatedTree);
		expect(entries).toEqual([{ path: "file.txt", oid: newBlob, type: "blob" }]);
	});
});

describe("deleteFromTree", () => {
	it("removes a top-level file from a tree", async () => {
		const repo = makeRepo();
		const keepBlob = await writeBlob(repo, "keep");
		const deleteBlob = await writeBlob(repo, "delete");
		const baseTree = await upsertTree(
			repo,
			undefined,
			new Map([
				["keep.txt", keepBlob],
				["delete-me.txt", deleteBlob],
			]),
		);

		const updatedTree = await deleteFromTree(repo, baseTree, "delete-me.txt");
		const entries = await readTreePaths(repo, updatedTree);
		expect(entries).toEqual([expect.objectContaining({ path: "keep.txt" })]);
	});

	it("removes a nested file and returns updated tree", async () => {
		const repo = makeRepo();
		const keepBlob = await writeBlob(repo, "keep");
		const removeBlob = await writeBlob(repo, "remove");
		const baseTree = await upsertTree(
			repo,
			undefined,
			new Map([
				["dir/keep.md", keepBlob],
				["dir/remove.md", removeBlob],
			]),
		);

		const updatedTree = await deleteFromTree(repo, baseTree, "dir/remove.md");
		const root = await readTreePaths(repo, updatedTree);
		expect(root).toEqual([expect.objectContaining({ path: "dir" })]);
		const dirOid = root[0]?.oid as string;
		const dirEntries = await readTreePaths(repo, dirOid);
		expect(dirEntries).toEqual([expect.objectContaining({ path: "keep.md" })]);
	});
});

describe("findTreeEntry", () => {
	it("returns root tree entry for empty path", async () => {
		const repo = makeRepo();
		const result = await findTreeEntry(repo, "root-oid", "");
		expect(result).toEqual({
			path: "",
			mode: "040000",
			type: "tree",
			oid: "root-oid",
		});
	});

	it("finds a top-level blob", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "readme");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["README.md", blobOid]]),
		);

		const result = await findTreeEntry(repo, treeOid, "README.md");
		expect(result).toEqual({
			path: "README.md",
			mode: "100644",
			type: "blob",
			oid: blobOid,
		});
	});

	it("finds a nested blob", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "console.log(1)");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["src/index.js", blobOid]]),
		);

		const result = await findTreeEntry(repo, treeOid, "src/index.js");
		expect(result).toEqual({
			path: "src/index.js",
			mode: "100644",
			type: "blob",
			oid: blobOid,
		});
	});

	it("returns null for non-existent path", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "readme");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["README.md", blobOid]]),
		);

		const result = await findTreeEntry(repo, treeOid, "nonexistent.txt");
		expect(result).toBeNull();
	});

	it("returns null when intermediate path is a blob not a tree", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "content");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["file.txt", blobOid]]),
		);

		const result = await findTreeEntry(repo, treeOid, "file.txt/child");
		expect(result).toBeNull();
	});
});

describe("listTreeEntries", () => {
	it("lists entries in root tree", async () => {
		const repo = makeRepo();
		const blobA = await writeBlob(repo, "a");
		const blobB = await writeBlob(repo, "b");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([
				["a.txt", blobA],
				["b.txt", blobB],
			]),
		);

		const result = await listTreeEntries(repo, treeOid);
		expect(result).toHaveLength(2);
		expect(result.find((e) => e.path === "a.txt")).toEqual({
			path: "a.txt",
			mode: "100644",
			type: "blob",
			oid: blobA,
		});
	});

	it("lists entries with prefix", async () => {
		const repo = makeRepo();
		const blobOid = await writeBlob(repo, "content");
		const treeOid = await upsertTree(
			repo,
			undefined,
			new Map([["file.txt", blobOid]]),
		);

		const result = await listTreeEntries(repo, treeOid, "src");
		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe("src/file.txt");
	});
});
