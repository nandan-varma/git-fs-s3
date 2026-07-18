import git from "isomorphic-git";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitFsClient } from "../src/index.js";
import {
	createCachedStore,
	createGitFs,
	MemoryObjectStore,
} from "../src/index.js";

const author = {
	name: "Test",
	email: "test@example.com",
	timestamp: 1700000000,
	timezoneOffset: 0,
};

async function commitFile(
	fs: GitFsClient,
	gitdir: string,
	options: { path: string; content: string; message: string; parent: string[] },
) {
	const blobOid = await git.writeBlob({
		fs,
		gitdir,
		blob: new TextEncoder().encode(options.content),
	});
	const treeOid = await git.writeTree({
		fs,
		gitdir,
		tree: [{ mode: "100644", path: options.path, oid: blobOid, type: "blob" }],
	});
	const commitOid = await git.writeCommit({
		fs,
		gitdir,
		commit: {
			message: options.message,
			tree: treeOid,
			parent: options.parent,
			author,
			committer: author,
		},
	});
	return { blobOid, treeOid, commitOid };
}

describe("isomorphic-git end-to-end on MemoryObjectStore", () => {
	let fs: GitFsClient;
	const gitdir = "/repo.git";

	beforeEach(async () => {
		fs = createGitFs(new MemoryObjectStore());
		await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
	});

	it("initializes a bare repository", async () => {
		const head = await fs.promises.readFile(`${gitdir}/HEAD`, "utf8");
		expect(head).toContain("refs/heads/main");
	});

	it("writes and reads commits, trees, and blobs", async () => {
		const { blobOid, commitOid } = await commitFile(fs, gitdir, {
			path: "hello.txt",
			content: "hello world\n",
			message: "initial commit\n",
			parent: [],
		});

		const { blob } = await git.readBlob({ fs, gitdir, oid: blobOid });
		expect(new TextDecoder().decode(blob)).toBe("hello world\n");

		const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
		expect(commit.message).toBe("initial commit\n");
		expect(commit.author.name).toBe("Test");
	});

	it("updates refs and walks history with git.log", async () => {
		const first = await commitFile(fs, gitdir, {
			path: "a.txt",
			content: "one",
			message: "first\n",
			parent: [],
		});
		const second = await commitFile(fs, gitdir, {
			path: "a.txt",
			content: "two",
			message: "second\n",
			parent: [first.commitOid],
		});
		await git.writeRef({
			fs,
			gitdir,
			ref: "refs/heads/main",
			value: second.commitOid,
			force: true,
		});

		const resolved = await git.resolveRef({ fs, gitdir, ref: "main" });
		expect(resolved).toBe(second.commitOid);

		const log = await git.log({ fs, gitdir, ref: "main" });
		expect(log.map((entry) => entry.commit.message)).toEqual([
			"second\n",
			"first\n",
		]);
	});

	it("creates, lists, and deletes branches", async () => {
		const { commitOid } = await commitFile(fs, gitdir, {
			path: "f",
			content: "x",
			message: "c\n",
			parent: [],
		});
		await git.writeRef({
			fs,
			gitdir,
			ref: "refs/heads/main",
			value: commitOid,
			force: true,
		});
		await git.branch({ fs, gitdir, ref: "feature" });

		expect((await git.listBranches({ fs, gitdir })).sort()).toEqual([
			"feature",
			"main",
		]);

		await git.deleteBranch({ fs, gitdir, ref: "feature" });
		expect(await git.listBranches({ fs, gitdir })).toEqual(["main"]);
	});

	it("reads trees back", async () => {
		const { treeOid } = await commitFile(fs, gitdir, {
			path: "readme.md",
			content: "# hi",
			message: "docs\n",
			parent: [],
		});
		const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
		expect(tree).toHaveLength(1);
		expect(tree[0]?.path).toBe("readme.md");
	});

	it("works identically through the cached store", async () => {
		const cachedFs = createGitFs(
			createCachedStore(new MemoryObjectStore(), { cacheMisses: true }),
		);
		const dir = "/cached.git";
		await git.init({ fs: cachedFs, gitdir: dir, bare: true });
		const { commitOid } = await commitFile(cachedFs, dir, {
			path: "f",
			content: "cached",
			message: "via cache\n",
			parent: [],
		});
		await git.writeRef({
			fs: cachedFs,
			gitdir: dir,
			ref: "refs/heads/main",
			value: commitOid,
			force: true,
		});
		const log = await git.log({ fs: cachedFs, gitdir: dir, ref: "main" });
		expect(log).toHaveLength(1);
	});
});
