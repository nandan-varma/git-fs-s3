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
import { packFileName, parsePackDirectory } from "../pack-files.js";
import { rawFs } from "./types.js";

const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;
const OID_BYTES = 20;
const PACK_TRAILER_BYTES = 20;

const IDX_V2 = {
	magic: 0xff744f63,
	version: 2,
	headerBytes: 8,
	fanoutEntries: 256,
	/** Offsets with this bit set index the 64-bit large-offset table. */
	largeOffsetFlag: 0x80000000,
} as const;

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

/** An object's position in a pack, as listed by its `.idx`. */
interface PackIndexEntry {
	readonly oid: string;
	readonly offset: number;
}

/** Entries of a version-2 `.idx`; `null` for any other format. */
export function readPackIndex(idx: Uint8Array): PackIndexEntry[] | null {
	const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
	const namesStart = IDX_V2.headerBytes + IDX_V2.fanoutEntries * 4;
	if (
		idx.byteLength < namesStart ||
		view.getUint32(0) !== IDX_V2.magic ||
		view.getUint32(4) !== IDX_V2.version
	) {
		return null;
	}
	// The last fanout slot counts every object in the pack.
	const count = view.getUint32(namesStart - 4);
	const crcStart = namesStart + count * OID_BYTES;
	const offsetsStart = crcStart + count * 4;
	if (idx.byteLength < offsetsStart + count * 4) return null;

	const entries: PackIndexEntry[] = [];
	for (let i = 0; i < count; i++) {
		const offset = view.getUint32(offsetsStart + i * 4);
		// Packs over 2 GiB never reach this in-memory path; let the caller
		// fall back instead of half-supporting the large-offset table.
		if (offset & IDX_V2.largeOffsetFlag) return null;
		const at = namesStart + i * OID_BYTES;
		entries.push({ oid: toHex(idx.subarray(at, at + OID_BYTES)), offset });
	}
	return entries;
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

/** The variable-length type/size header that starts every pack entry. */
interface EntryHeader {
	readonly type: number;
	readonly size: number;
	/** Bytes the header occupies. */
	readonly length: number;
}

function readEntryHeader(bytes: Uint8Array, start: number): EntryHeader {
	let byte = bytes[start] as number;
	const type = (byte >> 4) & 0b111;
	let size = byte & 0b1111;
	let shift = 4;
	let at = start + 1;
	while (byte & 0x80) {
		byte = bytes[at++] as number;
		size += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	}
	return { type, size, length: at - start };
}

function encodeEntryHeader(type: number, size: number): Uint8Array {
	const bytes: number[] = [];
	let rest = Math.floor(size / 16);
	bytes.push((rest > 0 ? 0x80 : 0) | (type << 4) | (size % 16));
	while (rest > 0) {
		const low = rest % 128;
		rest = Math.floor(rest / 128);
		bytes.push((rest > 0 ? 0x80 : 0) | low);
	}
	return new Uint8Array(bytes);
}

/** `OFS_DELTA`'s negative base offset: big-endian base-128 with +1 carries. */
function readOfsDeltaOffset(
	bytes: Uint8Array,
	start: number,
): { distance: number; length: number } {
	let at = start;
	let byte = bytes[at++] as number;
	let distance = byte & 0x7f;
	while (byte & 0x80) {
		byte = bytes[at++] as number;
		distance = (distance + 1) * 128 + (byte & 0x7f);
	}
	return { distance, length: at - start };
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
