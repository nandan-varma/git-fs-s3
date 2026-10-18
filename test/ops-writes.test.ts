import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import {
	createGitFs,
	GitInvalidRequestError,
	GitPathNotFoundError,
	MemoryObjectStore,
	type ObjectStore,
} from "../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	deleteFileFromBare,
	type Repo,
	withPackedWrites,
} from "../src/ops/index.js";

const author = authorNow("Test", "test@example.com");

/** A repo whose store records the order of every put. */
async function makeRepo(): Promise<{
	repo: Repo;
	store: MemoryObjectStore;
	puts: string[];
}> {
	const store = new MemoryObjectStore();
	const puts: string[] = [];
	const recording: ObjectStore = {
		get: (k) => store.get(k),
		head: (k) => store.head(k),
		list: (p, o) => store.list(p, o),
		delete: (k) => store.delete(k),
		put: (k, d) => {
			puts.push(k);
			return store.put(k, d);
		},
	};
	const repo = { fs: createGitFs(recording), gitdir: "git", cache: {} };
	await git.init({
		...repo,
		dir: repo.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	puts.length = 0;
	return { repo, store, puts };
}

const LOOSE = /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;

async function readText(repo: Repo, ref: string, filepath: string) {
	const oid = await git.resolveRef({ ...repo, ref });
	const { blob } = await git.readBlob({ ...repo, oid, filepath });
	return new TextDecoder().decode(blob);
}

describe("packed writes", () => {
	it("stores a commit's objects as one pack, written before the ref", async () => {
		const { repo, puts } = await makeRepo();
		await commitFilesToBare(repo, {
			branch: "main",
			message: "first\n",
			author,
			files: [
				{ path: "a.txt", content: "a\n" },
				{ path: "dir/b.txt", content: "b\n" },
			],
		});

		expect(puts.some((key) => LOOSE.test(key))).toBe(false);
		const pack = puts.findIndex((key) => key.endsWith(".pack"));
		const idx = puts.findIndex((key) => key.endsWith(".idx"));
		const ref = puts.indexOf("git/refs/heads/main");
		expect(pack).toBeGreaterThanOrEqual(0);
		expect(pack).toBeLessThan(idx);
		expect(idx).toBeLessThan(ref);
		expect(await readText(repo, "main", "dir/b.txt")).toBe("b\n");
	});

	it("serves reads of not-yet-flushed objects inside the callback", async () => {
		const { repo } = await makeRepo();
		await withPackedWrites(repo, async (packed) => {
			const oid = await git.writeBlob({
				...packed,
				blob: new TextEncoder().encode("x"),
			});
			const { blob } = await git.readBlob({ ...packed, oid });
			expect(new TextDecoder().decode(blob)).toBe("x");
		});
	});

	it("writes nothing when the callback throws before any ref write", async () => {
		const { repo, puts } = await makeRepo();
		await expect(
			withPackedWrites(repo, async (packed) => {
				await git.writeBlob({ ...packed, blob: new TextEncoder().encode("x") });
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(puts).toEqual([]);
	});
});

describe("commit tree edits", () => {
	async function seeded() {
		const made = await makeRepo();
		await commitFilesToBare(made.repo, {
			branch: "main",
			message: "seed\n",
			author,
			files: [
				{ path: "run.sh", content: "#!/bin/sh\n" },
				{ path: "dir/only.txt", content: "only\n" },
				{ path: "dir/keep/k.txt", content: "k\n" },
			],
		});
		return made;
	}

	it("keeps an existing file's mode when its content changes", async () => {
		const { repo } = await seeded();
		// Make run.sh executable with a raw tree edit, as a push would.
		const head = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		const { commit } = await git.readCommit({ ...repo, oid: head });
		const { tree } = await git.readTree({ ...repo, oid: commit.tree });
		const execTree = await git.writeTree({
			...repo,
			tree: tree.map((e) =>
				e.path === "run.sh" ? { ...e, mode: "100755" } : e,
			),
		});
		const execCommit = await git.writeCommit({
			...repo,
			commit: { ...commit, tree: execTree, parent: [head] },
		});
		await git.writeRef({
			...repo,
			ref: "refs/heads/main",
			value: execCommit,
			force: true,
		});

		const next = await commitFilesToBare(repo, {
			branch: "main",
			message: "edit\n",
			author,
			files: [{ path: "run.sh", content: "#!/bin/sh\necho hi\n" }],
		});
		const { commit: edited } = await git.readCommit({ ...repo, oid: next });
		const entries = (await git.readTree({ ...repo, oid: edited.tree })).tree;
		expect(entries.find((e) => e.path === "run.sh")?.mode).toBe("100755");
	});

	it("refuses to overwrite a directory with a file, or nest under a file", async () => {
		const { repo } = await seeded();
		const commit = (path: string) =>
			commitFilesToBare(repo, {
				branch: "main",
				message: "x\n",
				author,
				files: [{ path, content: "x\n" }],
			});
		await expect(commit("dir")).rejects.toBeInstanceOf(GitInvalidRequestError);
		await expect(commit("run.sh/inner")).rejects.toBeInstanceOf(
			GitInvalidRequestError,
		);
	});

	it.each([
		["../escape"],
		["a//b"],
		["a/./b"],
		["/abs"],
		[".git/config"],
		["sub/.GIT/hooks/x"],
		["trailing/"],
		[""],
	])("rejects the unsafe path %j", async (path) => {
		const { repo } = await seeded();
		await expect(
			commitFilesToBare(repo, {
				branch: "main",
				message: "x\n",
				author,
				files: [{ path, content: "x\n" }],
			}),
		).rejects.toBeInstanceOf(GitInvalidRequestError);
	});

	it("rejects duplicate paths in one commit", async () => {
		const { repo } = await seeded();
		await expect(
			commitFilesToBare(repo, {
				branch: "main",
				message: "x\n",
				author,
				files: [
					{ path: "a", content: "1" },
					{ path: "a", content: "2" },
				],
			}),
		).rejects.toBeInstanceOf(GitInvalidRequestError);
	});

	it("drops a directory left empty by a delete", async () => {
		const { repo } = await seeded();
		const sha = await deleteFileFromBare(repo, {
			branch: "main",
			filePath: "dir/keep/k.txt",
			message: "rm\n",
			author,
		});
		const { commit } = await git.readCommit({ ...repo, oid: sha });
		const dir = (await git.readTree({ ...repo, oid: commit.tree })).tree.find(
			(e) => e.path === "dir",
		);
		if (!dir) throw new Error("dir should remain (it still has only.txt)");
		const inner = (await git.readTree({ ...repo, oid: dir.oid })).tree;
		expect(inner.map((e) => e.path)).toEqual(["only.txt"]);
	});

	it("reports deleting a missing file as not found, without committing", async () => {
		const { repo } = await seeded();
		const before = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		await expect(
			deleteFileFromBare(repo, {
				branch: "main",
				filePath: "dir/nope.txt",
				message: "rm\n",
				author,
			}),
		).rejects.toBeInstanceOf(GitPathNotFoundError);
		await expect(
			deleteFileFromBare(repo, {
				branch: "main",
				filePath: "dir",
				message: "rm\n",
				author,
			}),
		).rejects.toBeInstanceOf(GitPathNotFoundError);
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(
			before,
		);
	});
});

describe("branch and merge edge cases", () => {
	it("creating an existing branch is a conflict; deleting the default branch is refused", async () => {
		const { createBranchFrom, deleteBranchByName } = await import(
			"../src/ops/index.js"
		);
		const { GitConflictError } = await import("../src/index.js");
		const { repo } = await makeRepo();
		await commitFilesToBare(repo, {
			branch: "main",
			message: "m\n",
			author,
			files: [{ path: "f", content: "f\n" }],
		});
		await createBranchFrom(repo, "feature", "main");
		await expect(
			createBranchFrom(repo, "feature", "main"),
		).rejects.toBeInstanceOf(GitConflictError);
		await expect(deleteBranchByName(repo, "main")).rejects.toBeInstanceOf(
			GitInvalidRequestError,
		);
		await deleteBranchByName(repo, "feature");
	});

	it("a fast-forward merge of an already-contained branch writes nothing", async () => {
		const { createBranchFrom, fastForwardMerge } = await import(
			"../src/ops/index.js"
		);
		const { repo } = await makeRepo();
		const first = await commitFilesToBare(repo, {
			branch: "main",
			message: "m\n",
			author,
			files: [{ path: "f", content: "f\n" }],
		});
		await createBranchFrom(repo, "old", "main");
		const tip = await commitFilesToBare(repo, {
			branch: "main",
			message: "n\n",
			author,
			files: [{ path: "g", content: "g\n" }],
		});
		expect(first).not.toBe(tip);
		await expect(fastForwardMerge(repo, "old", "main")).resolves.toEqual({
			success: true,
			commitSha: tip,
		});
		await expect(fastForwardMerge(repo, "main", "main")).resolves.toEqual({
			success: true,
			commitSha: tip,
		});
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(tip);
	});
});

describe("getDiffBetweenRefs (pull request diff)", () => {
	it("shows only the branch's changes, not base commits since the branch point", async () => {
		const { createBranchFrom, getDiffBetweenRefs, getCommitDiff } =
			await import("../src/ops/index.js");
		const { repo } = await makeRepo();
		await commitFilesToBare(repo, {
			branch: "main",
			message: "base\n",
			author,
			files: [{ path: "shared.txt", content: "v1\n" }],
		});
		await createBranchFrom(repo, "feature", "main");
		await commitFilesToBare(repo, {
			branch: "feature",
			message: "feature\n",
			author,
			files: [{ path: "feature.txt", content: "f\n" }],
		});
		// main moves on after the branch point.
		await commitFilesToBare(repo, {
			branch: "main",
			message: "main moves\n",
			author,
			files: [{ path: "shared.txt", content: "v2\n" }],
		});

		const diff = await getDiffBetweenRefs(repo, "main", "feature");
		expect(diff.files.map((f) => [f.path, f.status])).toEqual([
			["feature.txt", "added"],
		]);

		// A root commit's diff adds every file, nested ones included.
		const root = (await git.log({ ...repo, ref: "main" })).at(-1);
		if (!root) throw new Error("no root");
		const rootDiff = await getCommitDiff(repo, root.oid);
		expect(rootDiff.files).toMatchObject([
			{ path: "shared.txt", status: "added" },
		]);
	});

	it("keeps typed errors: a missing commit is GitObjectNotFoundError", async () => {
		const { getCommitDiff } = await import("../src/ops/index.js");
		const { GitObjectNotFoundError } = await import("../src/index.js");
		const { repo } = await makeRepo();
		await expect(getCommitDiff(repo, "a".repeat(40))).rejects.toBeInstanceOf(
			GitObjectNotFoundError,
		);
	});
});
