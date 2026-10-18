import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import {
	collectReachableOids,
	MAX_CONCURRENT_READS,
} from "../../src/http/reachability.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import type { Repo } from "../../src/ops/index.js";

const author = { name: "t", email: "t@e", timestamp: 0, timezoneOffset: 0 };

function makeRepo(store: MemoryObjectStore = new MemoryObjectStore()): Repo {
	return { fs: createGitFs(store), gitdir: "git", cache: {} };
}

/** A root commit whose tree holds `fileCount` blobs. */
async function commitWithFiles(
	repo: Repo,
	fileCount: number,
): Promise<{ commit: string; tree: string; blobs: string[] }> {
	const blobs: string[] = [];
	for (let i = 0; i < fileCount; i++) {
		blobs.push(
			await git.writeBlob({
				...repo,
				blob: new TextEncoder().encode(`file ${i}\n`),
			}),
		);
	}
	const tree = await git.writeTree({
		...repo,
		tree: blobs.map((oid, i) => ({
			mode: "100644",
			path: `file-${String(i).padStart(2, "0")}.txt`,
			oid,
			type: "blob",
		})),
	});
	const commit = await git.writeCommit({
		...repo,
		commit: { tree, parent: [], author, committer: author, message: "wide\n" },
	});
	return { commit, tree, blobs };
}

describe("collectReachableOids", () => {
	it("does not follow submodule gitlinks, which live in another repository", async () => {
		const repo = makeRepo();
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

	it("finds every object in a wide tree while holding at most MAX_CONCURRENT_READS reads", async () => {
		const repo = makeRepo();
		await git.init({ ...repo, dir: repo.gitdir, bare: true });
		const { commit, tree, blobs } = await commitWithFiles(repo, 40);

		const realReadObject = git.readObject;
		let inFlight = 0;
		let maxInFlight = 0;
		const spy = vi.spyOn(git, "readObject").mockImplementation(async (args) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				return await realReadObject(args);
			} finally {
				inFlight--;
			}
		});

		try {
			const { oids, complete } = await collectReachableOids(repo, [commit]);

			expect(complete).toBe(true);
			expect(new Set(oids)).toEqual(new Set([commit, tree, ...blobs]));
			expect(maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
			// If the bound were not what limited the walk, the fan-out would
			// have reached 40 — assert it actually engaged.
			expect(maxInFlight).toBe(MAX_CONCURRENT_READS);
		} finally {
			spy.mockRestore();
		}
	});

	it("retries a missing object once, then reports the walk incomplete", async () => {
		const store = new MemoryObjectStore();
		const repo = makeRepo(store);
		await git.init({ ...repo, dir: repo.gitdir, bare: true });
		const missingBlob = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("gone\n"),
		});
		const keptBlob = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("here\n"),
		});
		const tree = await git.writeTree({
			...repo,
			tree: [
				{ mode: "100644", path: "gone.txt", oid: missingBlob, type: "blob" },
				{ mode: "100644", path: "here.txt", oid: keptBlob, type: "blob" },
			],
		});
		const commit = await git.writeCommit({
			...repo,
			commit: { tree, parent: [], author, committer: author, message: "m\n" },
		});
		await store.delete(
			`git/objects/${missingBlob.slice(0, 2)}/${missingBlob.slice(2)}`,
		);

		const warnings: string[] = [];
		const { oids, complete } = await collectReachableOids(repo, [commit], {
			onWarn: (message) => warnings.push(message),
		});

		expect(complete).toBe(false);
		expect(warnings).toEqual([`missing object ${missingBlob}`]);
		// A failed read is never recorded as reachable, so repack can't treat
		// the missing object as verified.
		expect(new Set(oids)).toEqual(new Set([commit, tree, keptBlob]));
	});
});
