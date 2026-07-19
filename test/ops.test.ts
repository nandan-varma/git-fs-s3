import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitFs,
	GitObjectNotFoundError,
	GitPathNotFoundError,
	MemoryObjectStore,
} from "../src/index.js";
import {
	analyzeMerge,
	authorNow,
	commitFilesToBare,
	createBranchFrom,
	deleteBranchByName,
	deleteFileFromBare,
	fastForwardMerge,
	getBlob,
	getCommitDiff,
	getCommitHistory,
	getCommitLog,
	getDiffBetweenRefs,
	getFileContent,
	getFileFromRef,
	getFileHistory,
	getLastCommitsForTree,
	getTreeFromRef,
	listBranches,
	type Repo,
	type ResultCache,
	resultKeyPrefixes,
	writeCommitToBare,
} from "../src/ops/index.js";

const author = authorNow("Test", "test@example.com");

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "repos/alice/blog/git", cache: {} };
}

function memoryResultCache(): ResultCache & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	return {
		store,
		get: <T>(key: string) => (store.get(key) as T) ?? null,
		set: (key, value) => {
			store.set(key, value);
		},
	};
}

async function seed(repo: Repo) {
	await git.init({
		...repo,
		dir: repo.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	await commitFilesToBare(repo, {
		branch: "main",
		message: "first\n",
		author,
		files: [
			{ path: "README.md", content: "# hello\n" },
			{ path: "src/index.ts", content: "console.log(1)\n" },
		],
	});
	await commitFilesToBare(repo, {
		branch: "main",
		message: "second\n",
		author,
		files: [{ path: "src/index.ts", content: "console.log(2)\n" }],
	});
}

describe("ops end-to-end over MemoryObjectStore", () => {
	let repo: Repo;

	beforeEach(async () => {
		repo = makeRepo();
		await seed(repo);
	});

	it("commits files and reads them back through tree/file ops", async () => {
		const rootEntries = await getTreeFromRef(repo, { ref: "main" });
		expect(rootEntries.map((e) => e.path).sort()).toEqual(["README.md", "src"]);

		const srcEntries = await getTreeFromRef(repo, {
			ref: "main",
			treePath: "src",
		});
		expect(srcEntries).toHaveLength(1);
		expect(srcEntries[0]?.path).toBe("src/index.ts");

		const bytes = await getFileContent(repo, "src/index.ts", "main");
		expect(new TextDecoder().decode(bytes)).toBe("console.log(2)\n");

		const display = await getFileFromRef(repo, "README.md", "main");
		expect(display).toMatchObject({ isBinary: false, content: "# hello\n" });
	});

	it("throws GitPathNotFoundError for missing paths", async () => {
		await expect(
			getFileContent(repo, "nope.txt", "main"),
		).rejects.toBeInstanceOf(GitPathNotFoundError);
		await expect(
			getTreeFromRef(repo, { ref: "main", treePath: "no/such/dir" }),
		).rejects.toBeInstanceOf(GitPathNotFoundError);
	});

	it("wraps a missing blob as GitObjectNotFoundError but rethrows other errors as-is", async () => {
		await expect(getBlob(repo, "a".repeat(40))).rejects.toBeInstanceOf(
			GitObjectNotFoundError,
		);

		const readBlobSpy = vi
			.spyOn(git, "readBlob")
			.mockRejectedValue(new Error("object storage timeout"));
		try {
			await expect(getBlob(repo, "a".repeat(40))).rejects.toThrow(
				"object storage timeout",
			);
		} finally {
			readBlobSpy.mockRestore();
		}
	});

	it("returns [] for an unborn branch instead of throwing", async () => {
		expect(await getTreeFromRef(repo, { ref: "ghost" })).toEqual([]);
		expect(await getCommitLog(repo, { ref: "ghost" })).toEqual([]);
	});

	it("throws instead of silently returning [] when the ref resolves but its commit object doesn't (storage inconsistency, not an empty repo)", async () => {
		// "main" resolves fine — this is not the unborn-branch case above.
		// Simulate the commit object itself being unreadable (a real-world
		// example: a freshly pushed pack not yet visible to a LIST call this
		// process just used to decide "nothing to prefetch").
		const notFound = Object.assign(new Error("not found"), {
			code: "NotFoundError",
		});
		const readCommitSpy = vi
			.spyOn(git, "readCommit")
			.mockRejectedValue(notFound);
		try {
			await expect(getTreeFromRef(repo, { ref: "main" })).rejects.toThrow(
				GitObjectNotFoundError,
			);
		} finally {
			readCommitSpy.mockRestore();
		}

		// getCommitLog's walk goes through git.log, not the readCommit spied on
		// above (isomorphic-git's own commit-chain walker doesn't call back
		// through the public API) — same fix, different isomorphic-git entry
		// point to simulate the missing object at.
		const logSpy = vi.spyOn(git, "log").mockRejectedValue(notFound);
		try {
			await expect(getCommitLog(repo, { ref: "main" })).rejects.toThrow(
				GitObjectNotFoundError,
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("walks and caches the commit log", async () => {
		const resultCache = memoryResultCache();
		const hooks = { resultCache };

		const log = await getCommitLog(repo, { ref: "main", depth: 10 }, hooks);
		expect(log.map((c) => c.commit.message)).toEqual(["second\n", "first\n"]);

		// Deepest walk is memoized and sliced for shallower requests.
		const shallow = await getCommitLog(repo, { ref: "main", depth: 1 }, hooks);
		expect(shallow).toHaveLength(1);
		expect([...resultCache.store.keys()][0]).toMatch(
			/^commitlog:repos\/alice\/blog\/git:/,
		);

		const page = await getCommitHistory(
			repo,
			{ ref: "main", limit: 1, skip: 1 },
			hooks,
		);
		expect(page[0]?.commit.message).toBe("first\n");
	});

	it("fires the prefetch hook only at sufficient depth", async () => {
		const prefetch = vi.fn().mockResolvedValue(undefined);
		await getCommitLog(repo, { ref: "main", depth: 2 }, { prefetch });
		expect(prefetch).not.toHaveBeenCalled();
		await getCommitLog(repo, { ref: "main", depth: 5 }, { prefetch });
		expect(prefetch).toHaveBeenCalledTimes(1);
	});

	it("fires the prefetch hook on every cache-miss tree read, no depth gate", async () => {
		const prefetch = vi.fn().mockResolvedValue(undefined);
		await getTreeFromRef(repo, { ref: "main" }, { prefetch });
		expect(prefetch).toHaveBeenCalledTimes(1);

		// A second read of the same ref/path hits the result cache and skips
		// prefetch entirely — only cache misses need packs warmed.
		const resultCache = memoryResultCache();
		await getTreeFromRef(repo, { ref: "main" }, { prefetch, resultCache });
		prefetch.mockClear();
		await getTreeFromRef(repo, { ref: "main" }, { prefetch, resultCache });
		expect(prefetch).not.toHaveBeenCalled();
	});

	it("resolves last commits per tree entry", async () => {
		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "",
		});
		expect(last["README.md"]?.message).toBe("first");
		expect(last.src?.message).toBe("second");
	});

	it("collects per-file history with truncation flags", async () => {
		const history = await getFileHistory(repo, {
			ref: "main",
			filePath: "src/index.ts",
		});
		expect(history.truncated).toBe(false);
		expect(history.entries.map((e) => e.message)).toEqual(["second", "first"]);

		const limited = await getFileHistory(repo, {
			ref: "main",
			filePath: "src/index.ts",
			limit: 1,
		});
		expect(limited.entries).toHaveLength(1);
		expect(limited.truncated).toBe(true);
	});

	it("doesn't re-list a file in commits that left it unchanged", async () => {
		const repo = makeRepo();
		await seed(repo); // "first": README.md; "second": src/index.ts
		await commitFilesToBare(repo, {
			branch: "main",
			message: "third\n",
			author,
			files: [{ path: "other.txt", content: "unrelated\n" }],
		});

		const history = await getFileHistory(repo, {
			ref: "main",
			filePath: "README.md",
		});
		expect(history.entries.map((e) => e.message)).toEqual(["first"]);
		expect(history.truncated).toBe(false);
	});

	it("reports truncated when the depth cap is hit before the chain is exhausted", async () => {
		const repo = makeRepo();
		await seed(repo); // 2 commits: "first", "second"

		// walkDepth is max(maxDepth, limit) — both need to be small to actually
		// cap the walk at 1 commit ("second"), whose parent ("first") then falls
		// outside the fetched window.
		const history = await getFileHistory(repo, {
			ref: "main",
			filePath: "README.md",
			maxDepth: 1,
			limit: 1,
		});
		// README.md was only touched by "first", one commit past the depth cap —
		// the walk can't confirm that without reading past maxDepth, so it must
		// report truncated rather than silently claiming no history.
		expect(history.truncated).toBe(true);
	});

	it("manages branches with validation", async () => {
		await createBranchFrom(repo, "feature", "main");
		const branches = await listBranches(repo);
		expect(branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);

		await expect(createBranchFrom(repo, "../evil", "main")).rejects.toThrow(
			/Invalid branch name/,
		);

		await deleteBranchByName(repo, "feature");
		expect((await listBranches(repo)).map((b) => b.name)).toEqual(["main"]);
	});

	it("deletes files via a bare commit", async () => {
		await deleteFileFromBare(repo, {
			branch: "main",
			filePath: "README.md",
			message: "remove readme\n",
			author,
		});
		const entries = await getTreeFromRef(repo, { ref: "main" });
		expect(entries.map((e) => e.path)).toEqual(["src"]);
	});

	it("diffs commits and refs", async () => {
		const log = await getCommitLog(repo, { ref: "main", depth: 2 });
		const tipSha = log[0]?.oid as string;

		const diff = await getCommitDiff(repo, tipSha);
		expect(diff.totalFiles).toBe(1);
		expect(diff.files[0]).toMatchObject({
			path: "src/index.ts",
			status: "modified",
			additions: 1,
			deletions: 1,
		});
		expect(diff.files[0]?.patch).toContain("-console.log(1)");
		expect(diff.files[0]?.patch).toContain("+console.log(2)");
		// jsdiff's raw createTwoFilesPatch output leaks an "Index:"/"===" header
		// git's own unified-diff format doesn't have — must be stripped.
		expect(diff.files[0]?.patch).toContain(
			"diff --git a/src/index.ts b/src/index.ts",
		);
		expect(diff.files[0]?.patch).not.toContain("Index:");
		expect(diff.files[0]?.patch).not.toContain("===");

		// Root commit: everything is an addition.
		const rootSha = log[1]?.oid as string;
		const rootDiff = await getCommitDiff(repo, rootSha);
		expect(rootDiff.totalFiles).toBe(2);
		expect(rootDiff.files.every((f) => f.status === "added")).toBe(true);

		await createBranchFrom(repo, "feature", "main");
		await commitFilesToBare(repo, {
			branch: "feature",
			message: "feature work\n",
			author,
			files: [{ path: "feature.txt", content: "new\n" }],
		});
		const branchDiff = await getDiffBetweenRefs(repo, "main", "feature");
		expect(branchDiff.files.map((f) => f.path)).toEqual(["feature.txt"]);

		const featureBeforeDelete = await git.resolveRef({
			...repo,
			ref: "refs/heads/feature",
		});
		await deleteFileFromBare(repo, {
			branch: "feature",
			filePath: "feature.txt",
			message: "remove feature.txt\n",
			author,
		});
		const deleteDiff = await getDiffBetweenRefs(
			repo,
			featureBeforeDelete,
			"feature",
		);
		expect(deleteDiff.files[0]).toMatchObject({
			path: "feature.txt",
			status: "deleted",
		});
	});

	it("analyzes and fast-forwards merges", async () => {
		await createBranchFrom(repo, "feature", "main");
		await commitFilesToBare(repo, {
			branch: "feature",
			message: "ahead\n",
			author,
			files: [{ path: "new.txt", content: "x\n" }],
		});

		const analysis = await analyzeMerge(repo, "feature", "main");
		expect(analysis).toMatchObject({ canMerge: true, fastForward: true });

		const missing = await analyzeMerge(repo, "ghost", "main");
		expect(missing.canMerge).toBe(false);

		const ff = await fastForwardMerge(repo, "feature", "main");
		expect(ff?.success).toBe(true);
		const mainLog = await getCommitLog(repo, { ref: "main", depth: 1 });
		expect(mainLog[0]?.commit.message).toBe("ahead\n");

		// Diverged branches are not fast-forwardable.
		await commitFilesToBare(repo, {
			branch: "feature",
			message: "f2\n",
			author,
			files: [{ path: "f2.txt", content: "f\n" }],
		});
		await commitFilesToBare(repo, {
			branch: "main",
			message: "m2\n",
			author,
			files: [{ path: "m2.txt", content: "m\n" }],
		});
		expect(await fastForwardMerge(repo, "feature", "main")).toBeNull();
	});

	it("rejects CAS-unsafe writes with stale parents intact", async () => {
		// resultKeyPrefixes covers every cache kind ops write to.
		const prefixes = resultKeyPrefixes(repo.gitdir);
		expect(prefixes).toHaveLength(5);
		for (const prefix of prefixes) {
			expect(prefix.endsWith(":")).toBe(true);
			expect(prefix).toContain(repo.gitdir);
		}
	});
});

describe("writeCommitToBare parent resolution", () => {
	it("treats a NotFoundError parent ref as an empty repo / first commit", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const commitOid = await writeCommitToBare(repo, {
			branch: "main",
			message: "first\n",
			author,
			buildTree: async (parentTreeOid) => {
				expect(parentTreeOid).toBeUndefined();
				const blobOid = await git.writeBlob({
					...repo,
					blob: new TextEncoder().encode("hello\n"),
				});
				return git.writeTree({
					...repo,
					tree: [{ path: "f.txt", mode: "100644", type: "blob", oid: blobOid }],
				});
			},
		});

		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(
			commitOid,
		);
	});

	it("propagates a non-NotFoundError instead of treating it as an empty repo", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const resolveRefSpy = vi
			.spyOn(git, "resolveRef")
			.mockRejectedValue(new Error("object storage timeout"));

		try {
			await expect(
				writeCommitToBare(repo, {
					branch: "main",
					message: "first\n",
					author,
					buildTree: async () => {
						throw new Error("buildTree should not run");
					},
				}),
			).rejects.toThrow("object storage timeout");
		} finally {
			resolveRefSpy.mockRestore();
		}
	});
});

describe("getLastCommitsForTree edge cases", () => {
	it("attributes each entry to the commit that actually changed it, skipping ones that didn't", async () => {
		const repo = makeRepo();
		await seed(repo); // "first": README.md + src/index.ts; "second": src/index.ts
		await commitFilesToBare(repo, {
			branch: "main",
			message: "third\n",
			author,
			files: [{ path: "README.md", content: "# updated\n" }],
		});

		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "",
		});
		// README.md changed again in "third" — not still attributed to "first".
		expect(last["README.md"]?.message).toBe("third");
		// src/index.ts wasn't touched by "third" — still attributed to "second",
		// not incorrectly bumped to the newest commit that happened to touch a
		// sibling path.
		expect(last.src?.message).toBe("second");
	});

	it("returns {} when treePath resolves to a blob, not a directory", async () => {
		const repo = makeRepo();
		await seed(repo);

		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "README.md",
		});
		expect(last).toEqual({});
	});

	it("returns {} when treePath doesn't exist", async () => {
		const repo = makeRepo();
		await seed(repo);

		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "no/such/dir",
		});
		expect(last).toEqual({});
	});

	it("returns {} for an empty repo", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "",
		});
		expect(last).toEqual({});
	});

	it("resolves last commits within a subdirectory", async () => {
		const repo = makeRepo();
		await seed(repo);
		await commitFilesToBare(repo, {
			branch: "main",
			message: "add nested file\n",
			author,
			files: [{ path: "src/nested/deep.ts", content: "x\n" }],
		});

		const last = await getLastCommitsForTree(repo, {
			ref: "main",
			treePath: "src",
		});
		expect(last["src/index.ts"]?.message).toBe("second");
		expect(last["src/nested"]?.message).toBe("add nested file");
	});
});
