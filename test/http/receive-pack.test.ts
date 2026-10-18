import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { pktLine } from "../../src/http/pkt-line.js";
import {
	applyReceivePack,
	parseReceivePackBody,
	receivePackResponse,
} from "../../src/http/receive-pack.js";
import { rawFs } from "../../src/http/types.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	type Repo,
} from "../../src/ops/index.js";

const author = authorNow("Test", "test@example.com");
const ZERO_OID = "0".repeat(40);

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "git", cache: {} };
}

/** Like {@link makeRepo}, but also exposes the backing store for tests that
 * need to simulate an unreadable object somewhere in pre-existing history. */
function makeRepoWithStore(): { repo: Repo; store: MemoryObjectStore } {
	const store = new MemoryObjectStore();
	return { repo: { fs: createGitFs(store), gitdir: "git", cache: {} }, store };
}

/**
 * Build a real packfile for a single new commit on top of `parentOid` (or a
 * root commit if undefined), by staging the commit's objects into `staging`
 * (any scratch repo) and packing them with the real isomorphic-git
 * packObjects — the same shape a real `git push` sends on the wire.
 */
async function buildPushPack(
	staging: Repo,
	parentOid: string | undefined,
	message: string,
): Promise<{ packfile: Uint8Array; commitOid: string }> {
	const blobOid = await git.writeBlob({
		...staging,
		blob: new TextEncoder().encode(`${message}\n`),
	});
	const treeOid = await git.writeTree({
		...staging,
		tree: [{ path: "file.txt", mode: "100644", type: "blob", oid: blobOid }],
	});
	const commitOid = await git.writeCommit({
		...staging,
		commit: {
			message: `${message}\n`,
			tree: treeOid,
			parent: parentOid ? [parentOid] : [],
			author,
			committer: author,
		},
	});
	const oids = [blobOid, treeOid, commitOid];
	const { packfile } = await git.packObjects({ ...staging, oids });
	return { packfile: packfile ?? new Uint8Array(), commitOid };
}

describe("applyReceivePack", () => {
	it("initializes an empty repo and accepts the first push", async () => {
		const repo = makeRepo();
		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			undefined,
			"first",
		);

		const body = concatBuffers(
			pktLine(`${ZERO_OID} ${commitOid} refs/heads/main\n`),
			new TextEncoder().encode("0000"),
			packfile,
		);

		const { results, stalePackPaths } = await applyReceivePack(
			repo,
			parseReceivePackBody(body),
			{ defaultBranch: "main" },
		);

		expect(results).toEqual([{ refName: "refs/heads/main", ok: true }]);
		expect(stalePackPaths).toEqual([]);

		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		expect(headOid).toBe(commitOid);
		const { blob } = await git.readBlob({
			...repo,
			oid: headOid,
			filepath: "file.txt",
		});
		expect(new TextDecoder().decode(blob)).toBe("first\n");
	});

	it("rejects a non-fast-forward push whose oldOid no longer matches", async () => {
		const repo = makeRepo();
		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const first = await buildPushPack(staging, undefined, "first");
		await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${ZERO_OID} ${first.commitOid} refs/heads/main\n`),
					new TextEncoder().encode("0000"),
					first.packfile,
				),
			),
			{ defaultBranch: "main" },
		);

		// Client still thinks main is at ZERO_OID (stale) — server disagrees.
		const second = await buildPushPack(staging, first.commitOid, "second");
		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${ZERO_OID} ${second.commitOid} refs/heads/main\n`),
					new TextEncoder().encode("0000"),
					second.packfile,
				),
			),
			{ defaultBranch: "main" },
		);

		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.reason).toContain("non-fast-forward");
		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		expect(headOid).toBe(first.commitOid); // unchanged
	});

	it("rejects a path-traversing ref name without touching the filesystem", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const evilRef = "refs/heads/../../other-repo/refs/heads/main";
		const evilOid = "a".repeat(40);

		const { results } = await applyReceivePack(
			repo,
			{
				refUpdates: [{ oldOid: ZERO_OID, newOid: evilOid, refName: evilRef }],
				packData: new Uint8Array(),
			},
			{ defaultBranch: "main" },
		);

		expect(results).toEqual([
			{ refName: evilRef, ok: false, reason: "invalid ref name" },
		]);
		await expect(
			git.resolveRef({ ...repo, ref: "refs/heads/main" }),
		).rejects.toThrow();
	});

	it("deletes a ref when newOid is all-zero", async () => {
		const repo = makeRepo();
		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			undefined,
			"first",
		);
		await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${ZERO_OID} ${commitOid} refs/heads/doomed\n`),
					new TextEncoder().encode("0000"),
					packfile,
				),
			),
			{ defaultBranch: "main" },
		);

		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${commitOid} ${ZERO_OID} refs/heads/doomed\n`),
					new TextEncoder().encode("0000"),
				),
			),
			{ defaultBranch: "main" },
		);

		expect(results).toEqual([{ refName: "refs/heads/doomed", ok: true }]);
		await expect(
			git.resolveRef({ ...repo, ref: "refs/heads/doomed" }),
		).rejects.toThrow();
	});

	it("triggers a repack once the pack-count threshold is crossed, without corrupting history", async () => {
		const repo = makeRepo();
		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		let parent: string | undefined;
		let lastOid = "";
		for (let i = 0; i < 5; i++) {
			const { packfile, commitOid } = await buildPushPack(
				staging,
				parent,
				`commit ${i}`,
			);
			await applyReceivePack(
				repo,
				parseReceivePackBody(
					concatBuffers(
						pktLine(`${parent ?? ZERO_OID} ${commitOid} refs/heads/main\n`),
						new TextEncoder().encode("0000"),
						packfile,
					),
				),
				{ defaultBranch: "main", repack: { threshold: 3 } },
			);
			parent = commitOid;
			lastOid = commitOid;
		}

		const log = await git.log({ ...repo, ref: "main" });
		expect(log.length).toBe(5);
		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		expect(headOid).toBe(lastOid);
	});

	it("validates a push against pre-existing history in objects proportional to the new commits, not the whole chain", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		// A long pre-existing chain, written straight to the bare repo (not
		// through applyReceivePack) — the object-graph validation added in
		// ee7ed2f used to re-walk *all* of this on every subsequent push.
		let parent: string | undefined;
		for (let i = 0; i < 25; i++) {
			parent = await commitFilesToBare(repo, {
				branch: "main",
				message: `commit ${i}\n`,
				author,
				files: [{ path: "file.txt", content: `v${i}\n` }],
			});
		}
		const oldTip = parent as string;

		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			oldTip,
			"new commit",
		);

		const readSpy = vi.spyOn(git, "readObject");
		readSpy.mockClear();

		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${oldTip} ${commitOid} refs/heads/main\n`),
					new TextEncoder().encode("0000"),
					packfile,
				),
			),
			// Seeding committed one pack per commit, so a repack would run its
			// own whole-repo walk; this measures validation alone.
			{ defaultBranch: "main", repack: false },
		);

		expect(results).toEqual([{ refName: "refs/heads/main", ok: true }]);
		// Only the new commit's own objects (commit, tree, blob) should have
		// been read — not the 25-commit, 75-object pre-existing chain.
		expect(readSpy.mock.calls.length).toBeLessThan(10);
		readSpy.mockRestore();
	});

	it("bounds a brand-new branch's validation walk at other existing refs' tips", async () => {
		// A new branch has no oldOid of its own (ZERO_OID) to bound its walk
		// against — the common real-world shape of this is a PR branch cut
		// from an already-pushed main. Without also using main's tip as a
		// boundary, creating that branch would re-walk main's entire history
		// on every single PR push.
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		let mainTip: string | undefined;
		for (let i = 0; i < 25; i++) {
			mainTip = await commitFilesToBare(repo, {
				branch: "main",
				message: `commit ${i}\n`,
				author,
				files: [{ path: "file.txt", content: `v${i}\n` }],
			});
		}

		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			mainTip,
			"pr commit",
		);

		const readSpy = vi.spyOn(git, "readObject");
		readSpy.mockClear();

		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${ZERO_OID} ${commitOid} refs/heads/pr-branch\n`),
					new TextEncoder().encode("0000"),
					packfile,
				),
			),
			// Seeding committed one pack per commit, so a repack would run its
			// own whole-repo walk; this measures validation alone.
			{ defaultBranch: "main", repack: false },
		);

		expect(results).toEqual([{ refName: "refs/heads/pr-branch", ok: true }]);
		expect(readSpy.mock.calls.length).toBeLessThan(10);
		readSpy.mockRestore();
	});

	it("still accepts a fast-forward push when pre-existing history has become unreadable", async () => {
		// Regression test for a real incident: the object-graph validation
		// walked the *entire* history reachable from the new tip on every
		// push, with no boundary at the ref's previous position. Any single
		// unreadable object anywhere in that history — even one with no
		// relation to the commits actually being pushed — rejected the push
		// with "incomplete object graph". Bounding the walk at the pre-image
		// oid (this file's other test) fixes the common case; this test
		// proves it holds even when the old history is genuinely gone.
		const { repo, store } = makeRepoWithStore();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const oldTip = await commitFilesToBare(repo, {
			branch: "main",
			message: "old history\n",
			author,
			files: [{ path: "file.txt", content: "v0\n" }],
		});

		// Simulate the old history becoming unreadable (e.g. a lost/expired
		// loose object or pack) by wiping every git object — but not the ref
		// itself, which is what a real bit-rot/GC-bug scenario would look
		// like too: the ref still resolves, its objects don't.
		const { objects } = await store.list("");
		await Promise.all(
			objects
				.filter(({ key }) => key.includes("/objects/"))
				.map(({ key }) => store.delete(key)),
		);

		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			oldTip,
			"new commit",
		);

		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${oldTip} ${commitOid} refs/heads/main\n`),
					new TextEncoder().encode("0000"),
					packfile,
				),
			),
			{ defaultBranch: "main" },
		);

		expect(results).toEqual([{ refName: "refs/heads/main", ok: true }]);
		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		expect(headOid).toBe(commitOid);
	});

	it("accepts a brand-new branch cut from an existing branch whose deeper history has become unreadable", async () => {
		// Same real incident as the test above, but for the shape that
		// actually broke in production: a *new* branch (a PR branch) cut from
		// main, where main's tip itself resolves fine but an object further
		// back in main's history is gone. A new branch has no oldOid of its
		// own, so without also bounding at *other* existing refs' tips (see
		// the "bounds a brand-new branch's..." test above), this walk would
		// still fall through to the hole.
		const { repo, store } = makeRepoWithStore();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		await commitFilesToBare(repo, {
			branch: "main",
			message: "commit that will become unreadable\n",
			author,
			files: [{ path: "file.txt", content: "v0\n" }],
		});
		const { objects: objectsAfterFirstCommit } = await store.list("");
		const firstCommitObjectKeys = objectsAfterFirstCommit
			.map(({ key }) => key)
			.filter((key) => key.includes("/objects/"));

		const mainTip = await commitFilesToBare(repo, {
			branch: "main",
			message: "commit that stays readable\n",
			author,
			files: [{ path: "file.txt", content: "v1\n" }],
		});

		// Only the *older* commit's own objects go missing — mainTip and its
		// tree/blob are untouched, so main's own ref still resolves and reads
		// fine; only a full walk past it would notice the hole.
		await Promise.all(firstCommitObjectKeys.map((key) => store.delete(key)));

		const staging = makeRepo();
		await git.init({
			...staging,
			dir: staging.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const { packfile, commitOid } = await buildPushPack(
			staging,
			mainTip,
			"pr commit",
		);

		const { results } = await applyReceivePack(
			repo,
			parseReceivePackBody(
				concatBuffers(
					pktLine(`${ZERO_OID} ${commitOid} refs/heads/pr-branch\n`),
					new TextEncoder().encode("0000"),
					packfile,
				),
			),
			{ defaultBranch: "main" },
		);

		expect(results).toEqual([{ refName: "refs/heads/pr-branch", ok: true }]);
	});

	it("builds a report-status response from receivePackResponse", () => {
		const result = receivePackResponse([
			{ refName: "refs/heads/main", ok: true },
			{ refName: "refs/heads/bad", ok: false, reason: "invalid ref name" },
		]);
		const text = new TextDecoder().decode(result.body);
		expect(text).toContain("unpack ok");
		expect(text).toContain("ok refs/heads/main");
		expect(text).toContain("ng refs/heads/bad invalid ref name");
	});
});

function concatBuffers(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

describe("receive-pack — protocol edge cases", () => {
	async function initRepo(): Promise<Repo> {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		return repo;
	}

	function body(commands: string[], pack?: Uint8Array): Uint8Array {
		return concatBuffers(
			...commands.map((command) => pktLine(command)),
			new TextEncoder().encode("0000"),
			...(pack ? [pack] : []),
		);
	}

	it("parses the client's capabilities and drops commands with malformed oids", () => {
		const parsed = parseReceivePackBody(
			body([
				`${ZERO_OID} ${"a".repeat(40)} refs/heads/main\0report-status side-band-64k\n`,
				`${ZERO_OID} not-an-oid refs/heads/bad\n`,
			]),
		);
		expect(parsed.capabilities).toEqual(["report-status", "side-band-64k"]);
		expect(parsed.refUpdates.map((u) => u.refName)).toEqual([
			"refs/heads/main",
		]);
	});

	it("frames the report in side-band-64k when the client asked for it", () => {
		const response = receivePackResponse(
			[{ refName: "refs/heads/main", ok: true }],
			{
				capabilities: ["report-status", "side-band-64k"],
			},
		);
		const bytes = response.body;
		// pkt-line header, then band 1, then the inner report-status pkt-lines.
		expect(bytes[4]).toBe(1);
		const inner = new TextDecoder().decode(bytes.subarray(5));
		expect(inner).toContain("unpack ok");
		expect(inner).toContain("ok refs/heads/main");
	});

	it("sends no report when the client didn't ask for report-status", () => {
		const response = receivePackResponse(
			[{ refName: "refs/heads/main", ok: true }],
			{
				capabilities: [],
			},
		);
		expect(response.body.length).toBe(0);
	});

	it("reports an unindexable pack as an unpack error, not a crash", async () => {
		const repo = await initRepo();
		const garbage = new TextEncoder().encode("PACK this is not a pack");
		const outcome = await applyReceivePack(
			repo,
			parseReceivePackBody(
				body([`${ZERO_OID} ${"b".repeat(40)} refs/heads/main\n`], garbage),
			),
			{ defaultBranch: "main", repack: false },
		);
		expect(outcome.unpackError).toBe("index-pack failed");
		expect(outcome.results).toEqual([
			{ refName: "refs/heads/main", ok: false, reason: "unpacker error" },
		]);
	});

	it("refuses a branch pointing at a non-commit", async () => {
		const repo = await initRepo();
		const staging = await initRepo();
		const { packfile, commitOid } = await buildPushPack(
			staging,
			undefined,
			"c",
		);
		const { commit } = await git.readCommit({ ...staging, oid: commitOid });
		const outcome = await applyReceivePack(
			repo,
			parseReceivePackBody(
				body(
					[
						`${ZERO_OID} ${commitOid} refs/heads/main\n`,
						`${ZERO_OID} ${commit.tree} refs/heads/tree-branch\n`,
					],
					packfile,
				),
			),
			{ defaultBranch: "main", repack: false },
		);
		expect(outcome.results[0]).toEqual({
			refName: "refs/heads/main",
			ok: true,
		});
		expect(outcome.results[1]).toMatchObject({ ok: false });
		expect(outcome.results[1]?.reason).toContain("must point at a commit");
	});

	it("refuses to delete the branch HEAD points to", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const tip = await commitFilesToBare(repo, {
			branch: "main",
			message: "m\n",
			author,
			files: [{ path: "f", content: "f\n" }],
		});
		const outcome = await applyReceivePack(
			repo,
			parseReceivePackBody(body([`${tip} ${ZERO_OID} refs/heads/main\n`])),
			{ defaultBranch: "main", repack: false },
		);
		expect(outcome.results[0]?.reason).toBe(
			"deletion of the current branch prohibited",
		);
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(tip);
	});

	it("rejects two commands for the same ref", async () => {
		const repo = await initRepo();
		const staging = await initRepo();
		const { packfile, commitOid } = await buildPushPack(
			staging,
			undefined,
			"c",
		);
		const outcome = await applyReceivePack(
			repo,
			parseReceivePackBody(
				body(
					[
						`${ZERO_OID} ${commitOid} refs/heads/x\n`,
						`${ZERO_OID} ${commitOid} refs/heads/x\n`,
					],
					packfile,
				),
			),
			{ defaultBranch: "main", repack: false },
		);
		expect(outcome.results[1]).toEqual({
			refName: "refs/heads/x",
			ok: false,
			reason: "duplicate ref update",
		});
	});

	it("names the stored pack by its checksum", async () => {
		const repo = await initRepo();
		const staging = await initRepo();
		const { packfile, commitOid } = await buildPushPack(
			staging,
			undefined,
			"c",
		);
		await applyReceivePack(
			repo,
			parseReceivePackBody(
				body([`${ZERO_OID} ${commitOid} refs/heads/main\n`], packfile),
			),
			{ defaultBranch: "main", repack: false },
		);
		const names = await rawFs(repo).readdir("git/objects/pack");
		expect(names.some((n) => /^pack-[0-9a-f]{40}\.pack$/.test(n))).toBe(true);
	});
});
