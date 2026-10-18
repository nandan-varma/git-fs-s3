import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import {
	createGitFs,
	getObjectSize,
	MemoryObjectStore,
	type ObjectStore,
} from "../src/index.js";
import type { Repo } from "../src/ops/index.js";
import {
	OBJ_OFS_DELTA,
	OBJ_REF_DELTA,
	readEntryHeader,
} from "../src/pack-entry.js";
import { readPackIndex } from "../src/pack-index.js";

/**
 * `getObjectSize` exists so a caller can reject an oversized object *without*
 * inflating it, which means its answer has to be exact for every way git can
 * store an object — including the deltified entries whose "size" field in the
 * pack entry header describes the delta stream rather than the object. The
 * fixture is a real `git repack -adf` output whose blobs are OFS_DELTAs, so
 * comparing every size against the content isomorphic-git hands back covers
 * both.
 */
const FIXTURE = join(import.meta.dirname, "fixtures/deltified");

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

/** Every oid the fixture's pack indexes, with the entry header type of each. */
async function indexedObjects(
	store: MemoryObjectStore,
): Promise<Array<{ oid: string; type: number }>> {
	const packDir = "git/objects/pack";
	const names = await store.list(packDir);
	const idx = names.objects.find((o) => o.key.endsWith(".idx"));
	if (!idx) throw new Error("fixture has no pack index");
	const entries = readPackIndex(
		await store.get(idx.key).then((d) => d as Uint8Array),
	);
	if (!entries) throw new Error("fixture pack index is not v2");

	const pack = names.objects.find((o) => o.key.endsWith(".pack"));
	if (!pack) throw new Error("fixture has no pack");
	const bytes = (await store.get(pack.key)) as Uint8Array;

	return entries.map((entry) => ({
		oid: entry.oid,
		type: readEntryHeader(bytes, entry.offset).type,
	}));
}

describe("getObjectSize", () => {
	it("matches the real content length of every packed object, deltas included", async () => {
		const { repo, store } = await loadFixture();
		const objects = await indexedObjects(store);

		// The fixture is chosen because it *has* deltas; if it stopped having
		// them this test would silently stop covering the delta path.
		expect(
			objects.filter(
				(o) => o.type === OBJ_OFS_DELTA || o.type === OBJ_REF_DELTA,
			).length,
		).toBeGreaterThan(0);

		for (const { oid } of objects) {
			const { object } = await git.readObject({
				...repo,
				oid,
				format: "content",
			});
			expect(await getObjectSize(repo, oid)).toBe(
				(object as Uint8Array).byteLength,
			);
		}
	});

	it("returns null for a loose object, rather than guessing", async () => {
		const store = new MemoryObjectStore();
		const repo: Repo = { fs: createGitFs(store), gitdir: "git", cache: {} };
		await git.init({ ...repo, dir: "git", bare: true, defaultBranch: "main" });
		const oid = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("loose"),
		});

		// A loose object's size lives inside its compressed body, so there is
		// nothing to read cheaply — the caller is told "unknown", not a number.
		expect(await getObjectSize(repo, oid)).toBeNull();
	});

	it("returns null when the store cannot serve ranges", async () => {
		const { repo: fixtureRepo, store } = await loadFixture();
		const [first] = await indexedObjects(store);
		if (!first) throw new Error("fixture has no objects");

		const withoutRange: ObjectStore = {
			get: (k) => store.get(k),
			put: (k, d) => store.put(k, d),
			delete: (k) => store.delete(k),
			head: (k) => store.head(k),
			list: (p, o) => store.list(p, o),
		};
		const repo: Repo = {
			fs: createGitFs(withoutRange),
			gitdir: "git",
			cache: {},
		};

		// Fetching the whole pack to answer a size question is the cost this
		// exists to avoid, so an unsupported store reports "unknown".
		expect(await getObjectSize(repo, first.oid)).toBeNull();
		// The same object *is* measurable through a range-capable store, so the
		// null above is about the store, not about the object.
		expect(await getObjectSize(fixtureRepo, first.oid)).toBeTypeOf("number");
	});

	it("returns null for an object no pack lists", async () => {
		const { repo } = await loadFixture();
		expect(await getObjectSize(repo, "0".repeat(40))).toBeNull();
	});
});
