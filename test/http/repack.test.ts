/**
 * Regression coverage for repackRepository's pack trailer.
 *
 * buildVerifiedPack used to compute the trailing SHA-1 as a chained hash
 * (sha1(prevHash ++ chunk) repeated per chunk) instead of a single sha1 over
 * every preceding byte — a different, wrong value, since Web Crypto's
 * subtle.digest has no incremental mode. isomorphic-git's own pack reader
 * verifies this trailer on every subsequent read, so a corrupted trailer
 * doesn't fail loudly at repack time — it fails later, on the next clone or
 * log, with "Packfile trailer mismatch". These tests read the repacked pack
 * straight back through real isomorphic-git calls so that failure mode can't
 * hide.
 */
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { repackRepository } from "../../src/http/repack.js";
import { rawFs } from "../../src/http/types.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	type Repo,
} from "../../src/ops/index.js";
import { parsePackFileName } from "../../src/pack-files.js";

const author = authorNow("Test", "test@example.com");

function makeRepo(): { repo: Repo; store: MemoryObjectStore } {
	const store = new MemoryObjectStore();
	const fs = createGitFs(store);
	return { repo: { fs, gitdir: "repos/alice/blog/git", cache: {} }, store };
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

/** Fool countPacks' threshold check — its content is never read, only counted. */
async function addDummyPackFiles(repo: Repo, count: number) {
	const fsp = rawFs(repo);
	await fsp.mkdir(`${repo.gitdir}/objects/pack`, { recursive: true });
	for (let i = 0; i < count; i++) {
		await fsp.writeFile(
			`${repo.gitdir}/objects/pack/dummy-${i}.pack`,
			new Uint8Array([0]),
		);
	}
}

/**
 * isomorphic-git resolves an object from loose storage first if present,
 * falling back to packed storage only when no loose copy exists — so a
 * naive "read it back after repacking" test would keep silently reading the
 * pre-existing loose copies commitFilesToBare wrote, never touching the new
 * pack's trailer-verification path at all. Deleting the loose objects here
 * forces every subsequent read through the packed path.
 */
async function deleteLooseObjects(repo: Repo, store: MemoryObjectStore) {
	const prefix = `${repo.gitdir}/objects/`;
	const { objects } = await store.list(prefix);
	for (const { key } of objects) {
		if (key.includes("/pack/")) continue;
		await store.delete(key);
	}
}

describe("repackRepository", () => {
	it("produces a pack whose trailer isomorphic-git accepts on read-back", async () => {
		const { repo, store } = makeRepo();
		await seed(repo, 5);
		await addDummyPackFiles(repo, 4);

		const stalePaths = await repackRepository(repo, { threshold: 4 });

		expect(stalePaths.length).toBe(4);
		for (const p of stalePaths) {
			expect(p.startsWith("objects/pack/dummy-")).toBe(true);
		}

		// Force every subsequent read through the new pack (see
		// deleteLooseObjects's comment) so isomorphic-git's own packfile
		// trailer verification (readObjectPacked -> _checksumVerified) on the
		// new pack actually runs — a wrong trailer throws "Packfile trailer
		// mismatch" here, not at repack time.
		await deleteLooseObjects(repo, store);

		const log = await git.log({ ...repo, ref: "main" });
		expect(log.length).toBe(5);
		expect(log[0]?.commit.message).toBe("commit 4\n");

		const headOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		const { blob } = await git.readBlob({
			...repo,
			oid: headOid,
			filepath: "file.txt",
		});
		expect(new TextDecoder().decode(blob)).toBe("content 4\n");
	});

	it("independently verifies the trailer bytes match sha1 of the pack body", async () => {
		const { repo } = makeRepo();
		await seed(repo, 3);
		await addDummyPackFiles(repo, 4);

		await repackRepository(repo, { threshold: 4 });

		const fsp = rawFs(repo);
		const packDir = `${repo.gitdir}/objects/pack`;
		const entries = await fsp.readdir(packDir);
		const packFile = entries.find((f) => f.endsWith(".pack"));
		expect(packFile).toBeDefined();

		const packData = await fsp.readFile(`${packDir}/${packFile}`);
		const bytes =
			packData instanceof Uint8Array
				? packData
				: new TextEncoder().encode(packData as string);

		const body = bytes.subarray(0, bytes.length - 20);
		const trailer = bytes.subarray(bytes.length - 20);
		const expected = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
		expect(Array.from(trailer)).toEqual(Array.from(expected));
	});

	it("skips repacking below the pack-count threshold", async () => {
		const { repo } = makeRepo();
		await seed(repo, 2);
		await addDummyPackFiles(repo, 2);

		const stalePaths = await repackRepository(repo, { threshold: 4 });
		expect(stalePaths).toEqual([]);
	});

	it("consolidates fully packed repos by reusing entries, never growing", async () => {
		const { repo, store } = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		const fsp = rawFs(repo);
		const packDir = `${repo.gitdir}/objects/pack`;

		// Pack whatever is loose into its own pack, then drop the loose copies.
		async function packLoose(): Promise<string> {
			const { objects } = await store.list(`${repo.gitdir}/objects/`);
			const oids = objects
				.map(({ key }) => /objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/.exec(key))
				.filter((m): m is RegExpExecArray => m !== null)
				.map((m) => `${m[1]}${m[2]}`);
			const { filename } = await git.packObjects({
				...repo,
				oids,
				write: true,
			});
			await git.indexPack({ ...repo, dir: packDir, filepath: filename });
			await deleteLooseObjects(repo, store);
			return filename.replace(/\.pack$/, "");
		}

		await commitFilesToBare(repo, {
			branch: "main",
			message: "big\n",
			author,
			files: Array.from({ length: 20 }, (_, i) => ({
				path: `f${i}.txt`,
				// Incompressible, so this pack really dominates the small ones.
				content: Array.from({ length: 500 }, () =>
					Math.random().toString(36),
				).join(""),
			})),
		});
		// Total .pack bytes in the pack directory.
		async function packBytes(): Promise<number> {
			const { objects } = await store.list(`${packDir}/`);
			return objects
				.filter(
					({ key }) =>
						parsePackFileName(key.slice(packDir.length + 1))?.kind === "pack",
				)
				.reduce((sum, { size }) => sum + size, 0);
		}

		const base = await packLoose();
		await fsp.writeFile(`${packDir}/${base}.bitmap`, new Uint8Array([1]));
		const small: string[] = [];
		for (let i = 0; i < 3; i++) {
			await commitFilesToBare(repo, {
				branch: "main",
				message: `small ${i}\n`,
				author,
				files: [{ path: "small.txt", content: `${i}\n` }],
			});
			small.push(await packLoose());
		}

		const sourceBytes = await packBytes();
		const stale = await repackRepository(repo, { threshold: 4 });

		expect(stale).toEqual(
			expect.arrayContaining([
				`objects/pack/${base}.pack`,
				`objects/pack/${base}.bitmap`,
				...small.map((n) => `objects/pack/${n}.pack`),
			]),
		);
		const remaining = await fsp.readdir(packDir);
		expect(remaining.filter((f) => f.endsWith(".pack"))).toHaveLength(1);
		expect(await packBytes()).toBeLessThanOrEqual(sourceBytes);

		const log = await git.log({ ...repo, ref: "main" });
		expect(log.map((c) => c.commit.message)).toEqual([
			"small 2\n",
			"small 1\n",
			"small 0\n",
			"big\n",
		]);
		const head = log[0]?.oid as string;
		const { blob } = await git.readBlob({
			...repo,
			oid: head,
			filepath: "f3.txt",
		});
		expect(blob.length).toBeGreaterThan(1000);
	});

	it("removes .bitmap/.rev files of packs it replaces", async () => {
		const { repo } = makeRepo();
		await seed(repo, 2);
		await addDummyPackFiles(repo, 4);
		const fsp = rawFs(repo);
		await fsp.writeFile(
			`${repo.gitdir}/objects/pack/dummy-0.bitmap`,
			new Uint8Array([0]),
		);
		await fsp.writeFile(
			`${repo.gitdir}/objects/pack/dummy-0.rev`,
			new Uint8Array([0]),
		);

		const stale = await repackRepository(repo, { threshold: 4 });

		expect(stale).toContain("objects/pack/dummy-0.bitmap");
		expect(stale).toContain("objects/pack/dummy-0.rev");
	});
});
