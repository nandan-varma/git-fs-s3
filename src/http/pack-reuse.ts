/**
 * Build a packfile by copying already-compressed entries out of existing
 * packs ("pack reuse"), instead of inflating and re-deflating every object.
 *
 * Entries keep their stored form, deltas included, so the output is as
 * compact as the packs it came from. `OFS_DELTA` entries are rewritten as
 * `REF_DELTA` (base named by oid), since offsets don't survive the move into
 * a new pack; delta bases are always included and written before the deltas
 * that use them. Formats: gitformat-pack(5).
 *
 * Edge-compatible: Web Crypto SHA-1 and Uint8Array only.
 */

import { concat, encodeUtf8, fromHex, sha1, toHex } from "../edge-utils.js";
import type { Repo } from "../ops/types.js";
import {
	encodeEntryHeader,
	OBJ_OFS_DELTA,
	OBJ_REF_DELTA,
	OID_BYTES,
	readEntryHeader,
	readOfsDeltaOffset,
} from "../pack-entry.js";
import { packFileName, parsePackDirectory } from "../pack-files.js";
import { type PackIndexEntry, readPackIndex } from "../pack-index.js";
import { rawFs } from "./types.js";

const PACK_TRAILER_BYTES = 20;

/** One object's stored entry inside a pack. */
interface PackEntry {
	readonly pack: Uint8Array;
	readonly start: number;
	readonly end: number;
}

/** Every object stored in a pack, by oid, plus its offset → oid inverse. */
interface IndexedPack {
	readonly entries: Map<string, PackEntry>;
	readonly oidAtOffset: Map<number, string>;
}

/** Locate every entry of `pack` using its `.idx`. */
function indexPack(idx: Uint8Array, pack: Uint8Array): IndexedPack | null {
	const located = readPackIndex(idx);
	if (!located) return null;

	// An entry runs until the next entry's offset (or the pack trailer).
	located.sort((a, b) => a.offset - b.offset);
	const entries = new Map<string, PackEntry>();
	const oidAtOffset = new Map<number, string>();
	const packEnd = pack.byteLength - PACK_TRAILER_BYTES;
	for (let i = 0; i < located.length; i++) {
		const { oid, offset } = located[i] as PackIndexEntry;
		const end = located[i + 1]?.offset ?? packEnd;
		entries.set(oid, { pack, start: offset, end });
		oidAtOffset.set(offset, oid);
	}
	return { entries, oidAtOffset };
}

/** A pack entry ready to copy, with the oid of its delta base if any. */
interface ReusableEntry {
	readonly bytes: Uint8Array;
	readonly baseOid: string | null;
}

/** Copy one entry, rewriting `OFS_DELTA` to `REF_DELTA`. */
function reusableEntry(
	entry: PackEntry,
	indexed: IndexedPack,
): ReusableEntry | null {
	const { pack, start, end } = entry;
	const header = readEntryHeader(pack, start);
	const bodyStart = start + header.length;
	if (header.type === OBJ_REF_DELTA) {
		return {
			bytes: pack.subarray(start, end),
			baseOid: toHex(pack.subarray(bodyStart, bodyStart + OID_BYTES)),
		};
	}
	if (header.type !== OBJ_OFS_DELTA) {
		return { bytes: pack.subarray(start, end), baseOid: null };
	}
	const { distance, length } = readOfsDeltaOffset(pack, bodyStart);
	const baseOid = indexed.oidAtOffset.get(start - distance);
	if (baseOid === undefined) return null;
	return {
		bytes: concat(
			encodeEntryHeader(OBJ_REF_DELTA, header.size),
			fromHex(baseOid),
			pack.subarray(bodyStart + length, end),
		),
		baseOid,
	};
}

/**
 * A pack holding at least `oids`, built from stored entries, or `null` when
 * any of them (or a delta base they need) isn't in a readable pack — e.g. a
 * loose object — so the caller should build the pack another way.
 */
export async function buildPackFromExistingPacks(
	repo: Repo,
	oids: readonly string[],
): Promise<Uint8Array | null> {
	const fsp = rawFs(repo);
	const packDir = `${repo.gitdir}/objects/pack`;
	const packs = parsePackDirectory(
		await fsp.readdir(packDir).catch(() => [] as string[]),
	).filter((file) => file.kind === "pack");

	const indexes: IndexedPack[] = [];
	for (const { base } of packs) {
		// A pack without a readable index can't be reused.
		const [pack, idx] = await Promise.all([
			fsp.readFile(`${packDir}/${packFileName(base, "pack")}`),
			fsp.readFile(`${packDir}/${packFileName(base, "idx")}`),
		]).catch(() => [null, null]);
		if (!(pack instanceof Uint8Array) || !(idx instanceof Uint8Array)) {
			return null;
		}
		const indexed = indexPack(idx, pack);
		if (!indexed) return null;
		indexes.push(indexed);
	}

	const locate = (oid: string): ReusableEntry | null => {
		for (const indexed of indexes) {
			const entry = indexed.entries.get(oid);
			if (entry) return reusableEntry(entry, indexed);
		}
		return null;
	};

	// Depth-first so every base is written before the deltas that use it.
	const ordered: Uint8Array[] = [];
	const done = new Set<string>();
	const pending = new Set<string>();
	const visit = (oid: string): boolean => {
		if (done.has(oid)) return true;
		if (pending.has(oid)) return false; // a delta cycle means corruption
		const entry = locate(oid);
		if (!entry) return false;
		pending.add(oid);
		if (entry.baseOid !== null && !visit(entry.baseOid)) return false;
		pending.delete(oid);
		done.add(oid);
		ordered.push(entry.bytes);
		return true;
	};
	for (const oid of oids) {
		if (!visit(oid)) return null;
	}

	const header = new Uint8Array(12);
	header.set(encodeUtf8("PACK"), 0);
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, ordered.length);
	const body = concat(header, ...ordered);
	return concat(body, fromHex(await sha1(body)));
}
