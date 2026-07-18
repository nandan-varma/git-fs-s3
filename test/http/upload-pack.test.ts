import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { pktLine } from "../../src/http/pkt-line.js";
import { repackRepository } from "../../src/http/repack.js";
import { rawFs } from "../../src/http/types.js";
import { handleUploadPack } from "../../src/http/upload-pack.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	type Repo,
} from "../../src/ops/index.js";

const author = authorNow("Test", "test@example.com");

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "git", cache: {} };
}

async function seed(repo: Repo, commitCount: number) {
	await git.init({
		...repo,
		dir: repo.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	for (let i = 0; i < commitCount; i++) {
		await commitFilesToBare(repo, {
			branch: "main",
			message: `commit ${i}\n`,
			author,
			files: [{ path: "file.txt", content: `content ${i}\n` }],
		});
	}
}

/** Decode side-band-64k-framed packfile bytes back to the raw packfile. */
function decodeSideBandPackfile(buf: Uint8Array): Uint8Array {
	const chunks: Uint8Array[] = [];
	let pos = 0;
	let total = 0;
	while (pos + 4 <= buf.length) {
		const len = Number.parseInt(
			new TextDecoder().decode(buf.subarray(pos, pos + 4)),
			16,
		);
		if (len === 0) {
			pos += 4;
			break;
		}
		const band = buf[pos + 4];
		if (band !== 1) throw new Error(`unexpected side-band marker ${band}`);
		const chunk = buf.subarray(pos + 5, pos + len);
		chunks.push(chunk);
		total += chunk.length;
		pos += len;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/**
 * Simulate a real clone: index the served pack into a fresh empty repo, then
 * write the local ref the way a real client does from the ref advertisement
 * (indexing a pack alone doesn't touch refs).
 */
async function cloneInto(target: Repo, packfile: Uint8Array, headOid: string) {
	await git.init({
		...target,
		dir: target.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	const packDir = `${target.gitdir}/objects/pack`;
	const fsp = rawFs(target);
	await fsp.mkdir(packDir, { recursive: true });
	await fsp.writeFile(`${packDir}/clone.pack`, packfile);
	await git.indexPack({ ...target, dir: packDir, filepath: "clone.pack" });
	await git.writeRef({
		...target,
		ref: "refs/heads/main",
		value: headOid,
		force: true,
	});
}

describe("handleUploadPack", () => {
	it("returns a bare NAK when there are no wants", async () => {
		const repo = makeRepo();
		await seed(repo, 1);
		const result = await handleUploadPack(
			repo,
			new TextEncoder().encode("0000"),
		);
		expect(result.status).toBe(200);
		expect(new TextDecoder().decode(result.body)).toBe(pktLineDecoded("NAK\n"));
	});

	it("serves a full clone pack via the general reachability-walk path", async () => {
		const repo = makeRepo();
		await seed(repo, 3);
		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const body = concatBuffers(
			pktLine(`want ${headOid}\n`),
			new TextEncoder().encode("0000"),
			pktLine("done\n"),
		);
		const result = await handleUploadPack(repo, body);
		expect(result.status).toBe(200);

		const nakLen = 4;
		const nak = new TextDecoder().decode(result.body.subarray(4, nakLen + 4));
		expect(nak).toBe("NAK\n");
		const packfile = decodeSideBandPackfile(result.body.subarray(8));
		expect(new TextDecoder().decode(packfile.subarray(0, 4))).toBe("PACK");

		const clone = makeRepo();
		await cloneInto(clone, packfile, headOid);
		const log = await git.log({ ...clone, ref: "main" });
		expect(log.length).toBe(3);
		expect(log[0]?.commit.message).toBe("commit 2\n");
	});

	it("serves the consolidated pack directly on a fresh clone (single-pack fast path)", async () => {
		const repo = makeRepo();
		await seed(repo, 3);
		// Force down to exactly one pack so the fast path (readdir sees a
		// single .pack file) is what actually serves this request.
		await repackRepository(repo, { threshold: 1 });

		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		const body = concatBuffers(
			pktLine(`want ${headOid}\n`),
			new TextEncoder().encode("0000"),
			pktLine("done\n"),
		);
		const result = await handleUploadPack(repo, body);
		const packfile = decodeSideBandPackfile(result.body.subarray(8));

		const clone = makeRepo();
		await cloneInto(clone, packfile, headOid);
		const log = await git.log({ ...clone, ref: "main" });
		expect(log.length).toBe(3);
	});

	it("returns a bare NAK (no pack) when haves are sent without done", async () => {
		const repo = makeRepo();
		await seed(repo, 1);
		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const body = concatBuffers(
			pktLine(`want ${headOid}\n`),
			new TextEncoder().encode("0000"),
			pktLine(`have ${"a".repeat(40)}\n`),
			new TextEncoder().encode("0000"),
		);
		const result = await handleUploadPack(repo, body);
		expect(result.body.length).toBe(8); // pktLine("NAK\n") only
	});
});

function pktLineDecoded(s: string): string {
	return new TextDecoder().decode(pktLine(s));
}

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
