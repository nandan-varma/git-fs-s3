import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { buildPackFromExistingPacks } from "../../src/http/pack-reuse.js";
import { collectReachableOids } from "../../src/http/reachability.js";
import { rawFs } from "../../src/http/types.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import type { Repo } from "../../src/ops/index.js";

/** A real git-written pack (`git repack -adf`) whose blobs are OFS_DELTAs. */
const FIXTURE = join(import.meta.dirname, "../fixtures/deltified");

async function loadFixture(): Promise<{
	repo: Repo;
	store: MemoryObjectStore;
}> {
	const store = new MemoryObjectStore();
	const walk = async (dir: string): Promise<void> => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) await walk(path);
			else
				await store.put(
					`git/${path.slice(FIXTURE.length + 1)}`,
					new Uint8Array(readFileSync(path)),
				);
		}
	};
	await walk(FIXTURE);
	return { repo: { fs: createGitFs(store), gitdir: "git", cache: {} }, store };
}

async function reachableFromMain(repo: Repo): Promise<string[]> {
	const head = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
	const { oids, complete } = await collectReachableOids(repo, [head]);
	expect(complete).toBe(true);
	return oids;
}

describe("buildPackFromExistingPacks", () => {
	it("reuses deltified entries and produces a pack git can index with identical objects", async () => {
		const { repo } = await loadFixture();
		const oids = await reachableFromMain(repo);

		const pack = await buildPackFromExistingPacks(repo, oids);
		expect(pack).not.toBeNull();

		const target: Repo = {
			fs: createGitFs(new MemoryObjectStore()),
			gitdir: "clone",
			cache: {},
		};
		await git.init({ ...target, dir: target.gitdir, bare: true });
		const packDir = `${target.gitdir}/objects/pack`;
		await rawFs(target).writeFile(`${packDir}/reused.pack`, pack as Uint8Array);
		const { oids: indexed } = await git.indexPack({
			...target,
			dir: packDir,
			filepath: "reused.pack",
		});
		expect(new Set(indexed)).toEqual(new Set(oids));

		for (const oid of oids) {
			const [a, b] = await Promise.all([
				git.readObject({ ...repo, oid, format: "content" }),
				git.readObject({ ...target, oid, format: "content" }),
			]);
			expect(b.type).toBe(a.type);
			expect(b.object).toEqual(a.object);
		}

		// Deltas survived: far smaller than packing every object in full.
		const { packfile: full } = await git.packObjects({ ...repo, oids });
		expect((pack as Uint8Array).byteLength).toBeLessThan(
			(full as Uint8Array).byteLength / 2,
		);
	});

	it("returns null when an object isn't packed, so callers can fall back", async () => {
		const { repo } = await loadFixture();
		const loose = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("loose\n"),
		});
		const oids = [...(await reachableFromMain(repo)), loose];
		expect(await buildPackFromExistingPacks(repo, oids)).toBeNull();
	});
});
