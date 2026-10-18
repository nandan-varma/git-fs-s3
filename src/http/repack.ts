/**
 * Pack consolidation: merge all packs into one, reusing stored (possibly
 * deltified) entries when every object is packed.
 *
 * Edge-compatible: uses Web Crypto (SHA-1), CompressionStream (deflate),
 * and Uint8Array throughout — no node:crypto, node:zlib, or Buffer.
 */

import git from "isomorphic-git";
import type { Repo } from "../ops/types.js";
import {
	type PackFileName,
	packFileName,
	parsePackDirectory,
} from "../pack-files.js";
import {
	encodePack,
	hashGitObject,
	type PackObject,
	type PackObjectType,
	packBaseName,
} from "../pack-write.js";
import { buildPackFromExistingPacks } from "./pack-reuse.js";
import { collectReachableOids } from "./reachability.js";
import { type HttpHooks, rawFs } from "./types.js";

/**
 * Read every reachable object and independently re-derive its oid from the
 * bytes isomorphic-git handed back, instead of trusting the oid it was asked
 * for. isomorphic-git's *packed*-object read path never verifies the
 * resolved content's SHA-1 against the requested oid — only the
 * loose-object branch does.
 */
async function readAndVerifyObjects(
	repo: Repo,
	oids: string[],
): Promise<Map<string, PackObject>> {
	const objects = new Map<string, PackObject>();
	const BATCH_SIZE = 100;
	for (let i = 0; i < oids.length; i += BATCH_SIZE) {
		const batch = oids.slice(i, i + BATCH_SIZE);
		const entries = await Promise.all(
			batch.map(async (oid) => {
				const { type, object } = await git.readObject({
					...repo,
					oid,
					format: "content",
				});
				// Own ArrayBuffer-backed copy: Web APIs (Blob, digest) reject
				// views that might sit on a SharedArrayBuffer.
				const content = new Uint8Array(object as Uint8Array);
				const actualOid = await hashGitObject(type, content);
				if (actualOid !== oid) {
					throw new Error(
						`repack: object ${oid} failed independent SHA-1 verification ` +
							`(recomputed ${actualOid}) — refusing to trust this read, aborting repack`,
					);
				}
				return { oid, type: type as PackObjectType, content };
			}),
		);
		for (const { oid, type, content } of entries) {
			objects.set(oid, { type, content });
		}
	}
	return objects;
}

/**
 * Default repack threshold. Consolidating is O(total repo object count) —
 * so paying it on every push makes push latency grow with repo size forever.
 */
export const REPACK_PACK_COUNT_THRESHOLD = 4;

async function readPackDirectory(repo: Repo): Promise<PackFileName[]> {
	const entries = await rawFs(repo)
		.readdir(`${repo.gitdir}/objects/pack`)
		.catch(() => [] as string[]);
	return parsePackDirectory(entries);
}

async function countPacks(repo: Repo): Promise<number> {
	const files = await readPackDirectory(repo);
	return files.filter((file) => file.kind === "pack").length;
}

export interface RepackOptions {
	/** Skip repacking below this many accumulated packs. Default 4. */
	threshold?: number;
}

/**
 * Consolidate all pack files into one, returning the gitdir-relative paths
 * of the old .pack/.idx files it removed — after syncing the new pack to any
 * secondary storage, delete those same paths there too.
 */
export async function repackRepository(
	repo: Repo,
	options?: RepackOptions,
	hooks?: HttpHooks,
): Promise<string[]> {
	const threshold = options?.threshold ?? REPACK_PACK_COUNT_THRESHOLD;
	const fsp = rawFs(repo);
	try {
		if ((await countPacks(repo)) < threshold) {
			return [];
		}

		const [branches, tags] = await Promise.all([
			git.listBranches(repo),
			git.listTags(repo),
		]);
		const refNames = [
			...branches.map((b) => `refs/heads/${b}`),
			...tags.map((t) => `refs/tags/${t}`),
		];
		const tipOids = (
			await Promise.all(
				refNames.map((ref) =>
					git.resolveRef({ ...repo, ref }).catch(() => null),
				),
			)
		).filter((oid): oid is string => oid !== null);
		if (tipOids.length === 0) return [];

		// Blobs aren't read here: indexPack below re-hashes every object the
		// new pack holds and the reachable-set check rejects a pack missing any,
		// so inflating every blob in history during the walk too would only
		// double the cost.
		const { oids: reachable, complete } = await collectReachableOids(
			repo,
			tipOids,
			hooks,
			undefined,
			{ verifyBlobs: false },
		);
		if (!complete || reachable.length === 0) return [];

		const packDir = `${repo.gitdir}/objects/pack`;
		// Copy stored entries when everything is packed: keeps deltas, so
		// the consolidated pack is as compact as its sources. Loose objects
		// fall back to a verified, non-deltified rebuild.
		const packBuffer =
			(await buildPackFromExistingPacks(repo, reachable)) ??
			(await (async () => {
				const objects = await readAndVerifyObjects(repo, reachable);
				return encodePack(
					reachable.map((oid) => {
						const object = objects.get(oid);
						if (!object) {
							throw new Error(`repack: missing verified object for ${oid}`);
						}
						return object;
					}),
				);
			})());

		await fsp.mkdir(packDir, { recursive: true });
		const newBase = packBaseName(packBuffer);
		const newPackFile = packFileName(newBase, "pack");
		// Checksum-named, so an identical pack may already be stored — never
		// delete that one on the abort path below.
		const preexisting = (await readPackDirectory(repo)).some(
			(file) => file.base === newBase,
		);
		await fsp.writeFile(`${packDir}/${newPackFile}`, packBuffer);

		const { oids: indexedOids } = await git.indexPack({
			...repo,
			dir: packDir,
			filepath: newPackFile,
		});

		// indexPack re-hashes every object it indexes, so this also verifies
		// the content. Reused packs may carry extra delta bases: superset is fine.
		const indexed = new Set(indexedOids);
		if (reachable.some((oid) => !indexed.has(oid))) {
			if (!preexisting)
				await Promise.all(
					(["pack", "idx"] as const).map((kind) =>
						fsp
							.unlink(`${packDir}/${packFileName(newBase, kind)}`)
							.catch(() => {}),
					),
				);
			throw new Error(
				"repack: indexed pack is missing reachable objects — aborting",
			);
		}

		const stale = (await readPackDirectory(repo)).filter(
			(file) => file.base !== newBase,
		);
		// Indexes first: readers find packs through their .idx, so a reader
		// listing mid-cleanup sees either a complete old pack or none of it.
		const unlinkAll = (files: PackFileName[]) =>
			Promise.all(
				files.map((file) =>
					fsp.unlink(`${packDir}/${file.name}`).catch(() => {}),
				),
			);
		await unlinkAll(stale.filter((file) => file.kind === "idx"));
		await unlinkAll(stale.filter((file) => file.kind !== "idx"));
		return stale.map((file) => `objects/pack/${file.name}`);
	} catch (err) {
		hooks?.onWarn?.("repack failed (non-fatal)", err);
		return [];
	}
}
