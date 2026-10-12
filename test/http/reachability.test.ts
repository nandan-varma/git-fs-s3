import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { collectReachableOids } from "../../src/http/reachability.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import type { Repo } from "../../src/ops/index.js";

describe("collectReachableOids", () => {
	it("does not follow submodule gitlinks, which live in another repository", async () => {
		const repo: Repo = {
			fs: createGitFs(new MemoryObjectStore()),
			gitdir: "git",
			cache: {},
		};
		await git.init({ ...repo, dir: repo.gitdir, bare: true });
		const blob = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("hi\n"),
		});
		const gitlink = "1".repeat(40); // never stored in this repo
		const tree = await git.writeTree({
			...repo,
			tree: [
				{ mode: "100644", path: "file.txt", oid: blob, type: "blob" },
				{ mode: "160000", path: "sub", oid: gitlink, type: "commit" },
			],
		});
		const commit = await git.writeCommit({
			...repo,
			commit: {
				tree,
				parent: [],
				author: { name: "t", email: "t@e", timestamp: 0, timezoneOffset: 0 },
				committer: { name: "t", email: "t@e", timestamp: 0, timezoneOffset: 0 },
				message: "with submodule\n",
			},
		});

		const { oids, complete } = await collectReachableOids(repo, [commit]);
		expect(complete).toBe(true);
		expect(new Set(oids)).toEqual(new Set([commit, tree, blob]));
	});
});
