/**
 * Pack consolidation: merge packs into one verified, non-deltified pack,
 * leaving a dominant (already-compact) base pack untouched when there is one.
 *
 * Edge-compatible: uses Web Crypto (SHA-1), CompressionStream (deflate),
 * and Uint8Array throughout — no node:crypto, node:zlib, or Buffer.
 */

import git from "isomorphic-git";
import { concat, deflate, encodeUtf8, fromHex, sha1 } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import {
	type PackFileName,
	packFileName,
	parsePackDirectory,
} from "../pack-files.js";
import { readPackIndex } from "./pack-reuse.js";
import { collectReachableOids } from "./reachability.js";
import { type HttpHooks, rawFs } from "./types.js";

type PackObjectType = "commit" | "tree" | "blob" | "tag";

// Git pack object type bits (bits 6-4 of the header's first byte) — same
// constants real git and isomorphic-git's own (de)serializers use.
const PACK_OBJECT_TYPE_BITS: Record<PackObjectType, number> = {
	commit: 0b0010000,
	tree: 0b0100000,
	blob: 0b0110000,
	tag: 0b1000000,
};

// Git's pack object header: first byte packs (continuation bit | 3-bit type |
// low 4 bits of length); any remaining length is emitted 7 bits at a time,
// each with its own continuation bit, little-endian.
function encodePackObjectHeader(
	type: PackObjectType,
	length: number,
): Uint8Array {
	const bytes: number[] = [];
	let more = length > 0b1111;
	bytes.push(
		(more ? 0b10000000 : 0) | PACK_OBJECT_TYPE_BITS[type] | (length & 0b1111),
	);
	length >>>= 4;
	while (more) {
		more = length > 0b01111111;
		bytes.push((more ? 0b10000000 : 0) | (length & 0b01111111));
		length >>>= 7;
	}
	return new Uint8Array(bytes);
}

// Git's object hash: sha1("<type> <byte length>\0<content>") — matches
// isomorphic-git's internal GitObject.wrap + shasum, computed independently
// here rather than trusted from isomorphic-git's own read path.
async function hashGitObject(
	type: string,
	content: Uint8Array,
): Promise<string> {
	const prefix = encodeUtf8(`${type} ${content.length}\0`);
	return sha1(concat(prefix, content));
}

type VerifiedObject = { type: PackObjectType; content: Uint8Array };

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
): Promise<Map<string, VerifiedObject>> {
	const objects = new Map<string, VerifiedObject>();
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
				const content = object as unknown as Uint8Array;
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
 * Serialize verified objects into a pack containing only full (never
 * deltified) entries, in the given oid order.
 */
async function buildVerifiedPack(
	oids: string[],
	objects: Map<string, VerifiedObject>,
): Promise<Uint8Array> {
	// PACK header: "PACK" + version(2) + count, all big-endian uint32
	const header = new Uint8Array(12);
	const view = new DataView(header.buffer);
	header.set(encodeUtf8("PACK"), 0);
	view.setUint32(4, 2, false); // version 2
	view.setUint32(8, oids.length, false); // object count

	const chunks: Uint8Array[] = [header];

	const BATCH_SIZE = 100;
	for (let i = 0; i < oids.length; i += BATCH_SIZE) {
		const batch = oids.slice(i, i + BATCH_SIZE);
		const encoded = await Promise.all(
			batch.map(async (oid) => {
				const entry = objects.get(oid);
				if (!entry) {
					throw new Error(`repack: missing verified object for ${oid}`);
				}
				const objHeader = encodePackObjectHeader(
					entry.type,
					entry.content.length,
				);
				const compressed = await deflate(entry.content);
				return concat(objHeader, compressed);
			}),
		);
		chunks.push(...encoded);
	}

	// Git's pack trailer is the SHA-1 of every preceding byte (header +
	// every object entry) as a single digest — NOT an incremental/chained
	// hash. Web Crypto's subtle.digest has no streaming mode, so unlike
	// Node's crypto.createHash this can't be folded into the loop above;
	// everything is already buffered in `chunks`, so hash it in one pass.
	const packBody = concat(...chunks);
	const trailer = fromHex(await sha1(packBody));
	return concat(packBody, trailer);
}

/**
 * Default repack threshold. Consolidating is O(total repo object count) —
 * so paying it on every push makes push latency grow with repo size forever.
 */
export const REPACK_PACK_COUNT_THRESHOLD = 4;

/**
 * Geometric repacking factor, as in `git repack --geometric=2`: a pack at
 * least this many times the size of all other packs combined is left as-is
 * and only the packs around it are rolled up.
 */
const GEOMETRIC_FACTOR = 2;

interface BasePack {
	base: string;
	oids: Set<string>;
}

/**
 * The pack to keep untouched under {@link GEOMETRIC_FACTOR}, if any.
 * Rewriting a dominant pack gains nothing (it's already one pack) and loses
 * its delta compression, since packs built here are never deltified — a
 * git-pushed history can grow several-fold that way.
 */
async function findBasePack(
	repo: Repo,
	packs: readonly PackFileName[],
): Promise<BasePack | null> {
	const fsp = rawFs(repo);
	const packDir = `${repo.gitdir}/objects/pack`;
	const sized = await Promise.all(
		packs.map(async (pack) => {
			const stat = (await fsp.stat(`${packDir}/${pack.name}`)) as {
				size: number;
			};
			return { pack, size: stat.size };
		}),
	);
	sized.sort((a, b) => b.size - a.size);
	const [largest, ...rest] = sized;
	if (!largest) return null;
	const restTotal = rest.reduce((sum, { size }) => sum + size, 0);
	if (largest.size < GEOMETRIC_FACTOR * restTotal) return null;
	const idx = await fsp.readFile(
		`${packDir}/${packFileName(largest.pack.base, "idx")}`,
	);
	if (typeof idx === "string") return null;
	const entries = readPackIndex(idx);
	return entries
		? { base: largest.pack.base, oids: new Set(entries.map((e) => e.oid)) }
		: null;
}

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

		const { oids: reachable, complete } = await collectReachableOids(
			repo,
			tipOids,
			hooks,
		);
		if (!complete || reachable.length === 0) return [];

		const packDir = `${repo.gitdir}/objects/pack`;
		const before = await readPackDirectory(repo);
		const base = await findBasePack(
			repo,
			before.filter((file) => file.kind === "pack"),
		);
		const oids = base
			? reachable.filter((oid) => !base.oids.has(oid))
			: reachable;
		const removeAllExcept = async (keep: ReadonlySet<string>) => {
			const stale = (await readPackDirectory(repo)).filter(
				(file) => !keep.has(file.base),
			);
			await Promise.all(
				stale.map((file) =>
					fsp.unlink(`${packDir}/${file.name}`).catch(() => {}),
				),
			);
			return stale.map((file) => `objects/pack/${file.name}`);
		};
		const kept = new Set(base ? [base.base] : []);

		// Everything reachable is already in the base pack: the other packs
		// are pure redundancy.
		if (oids.length === 0) return removeAllExcept(kept);

		const objects = await readAndVerifyObjects(repo, oids);
		const packBuffer = await buildVerifiedPack(oids, objects);

		await fsp.mkdir(packDir, { recursive: true });
		const newBase = `pack-${Date.now()}`;
		const newPackFile = packFileName(newBase, "pack");
		await fsp.writeFile(`${packDir}/${newPackFile}`, packBuffer);

		const { oids: indexedOids } = await git.indexPack({
			...repo,
			dir: packDir,
			filepath: newPackFile,
		});

		const expected = new Set(oids);
		const indexed = new Set(indexedOids);
		if (
			indexed.size !== expected.size ||
			oids.some((oid) => !indexed.has(oid))
		) {
			await Promise.all(
				(["pack", "idx"] as const).map((kind) =>
					fsp
						.unlink(`${packDir}/${packFileName(newBase, kind)}`)
						.catch(() => {}),
				),
			);
			throw new Error(
				"repack: indexed pack's oid set didn't match the verified reachable set — aborting",
			);
		}

		kept.add(newBase);
		return removeAllExcept(kept);
	} catch (err) {
		hooks?.onWarn?.("repack failed (non-fatal)", err);
		return [];
	}
}
