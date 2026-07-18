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
});
