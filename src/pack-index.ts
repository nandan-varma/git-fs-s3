/**
 * Reading a pack's version-2 `.idx` (`gitformat-pack(5)`) — the oid → offset
 * table git writes beside every packfile.
 *
 * Kept separate from the code that reads pack *entries*: an index lookup is how
 * you find out which bytes to look at, and it is the cheap half of any question
 * about a packed object's contents (`http/pack-reuse.ts` copies entries into a
 * new pack; `object-size.ts` reads one entry's header).
 *
 * Edge-compatible: `Uint8Array` and `DataView` only.
 */

import { toHex } from "./edge-utils.js";
import { OID_BYTES } from "./pack-entry.js";

const IDX_V2 = {
	magic: 0xff744f63,
	version: 2,
	headerBytes: 8,
	fanoutEntries: 256,
	/** Offsets with this bit set index the 64-bit large-offset table. */
	largeOffsetFlag: 0x80000000,
} as const;

/** An object's position in a pack, as listed by its `.idx`. */
export interface PackIndexEntry {
	readonly oid: string;
	readonly offset: number;
}

/**
 * Entries of a version-2 `.idx`, in the index's own (oid) order; `null` for any
 * other format, or for one whose declared object count doesn't fit the bytes
 * present — an index that fails either check is not something to guess about.
 */
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
		// Packs over 2 GiB use the 64-bit offset table instead; callers that
		// can't handle it treat this as "not readable" rather than guessing.
		if (offset & IDX_V2.largeOffsetFlag) return null;
		const at = namesStart + i * OID_BYTES;
		entries.push({ oid: toHex(idx.subarray(at, at + OID_BYTES)), offset });
	}
	return entries;
}

/** Offset of `oid` in `idx`, or `null` when the index doesn't list it. */
export function findPackIndexOffset(
	idx: Uint8Array,
	oid: string,
): number | null {
	return readPackIndex(idx)?.find((entry) => entry.oid === oid)?.offset ?? null;
}
