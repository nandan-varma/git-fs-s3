import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { pktLine } from "../../src/http/pkt-line.js";
import {
	applyReceivePack,
	parseReceivePackBody,
	receivePackResponse,
} from "../../src/http/receive-pack.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import { authorNow, type Repo } from "../../src/ops/index.js";

const author = authorNow("Test", "test@example.com");
const ZERO_OID = "0".repeat(40);

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "git", cache: {} };
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
