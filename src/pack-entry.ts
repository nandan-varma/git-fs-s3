/**
 * Parsing the entry headers inside a git packfile (`gitformat-pack(5)`).
 *
 * Shared by the two places that read a pack's structure rather than its
 * objects: `http/pack-reuse.ts` (copying stored entries into a new pack) and
 * `object-size.ts` (answering an object's size without inflating it).
 *
 * Edge-compatible: `Uint8Array` only.
 */

/** Git pack object type bits (bits 6-4 of an entry's first byte). */
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

/** Bytes in a pack object's id, and in a `REF_DELTA`'s base reference. */
export const OID_BYTES = 20;

/** The variable-length type/size header that starts every pack entry. */
export interface EntryHeader {
	readonly type: number;
	/**
	 * For a whole object, its size in bytes. For a delta entry, the size of the
	 * **delta stream**, not of the object it reconstructs — that is in the delta
	 * header (see {@link readDeltaHeader}).
	 */
	readonly size: number;
	/** Bytes the header occupies. */
	readonly length: number;
}

/**
 * Read the entry header at `start`.
 *
 * A header that runs off the end of `bytes` yields whatever digits were
 * available: this reads from a bounded slice of a pack, and every caller
 * decides for itself whether the result is plausible (`length` beyond what it
 * read means "unknown", not "zero").
 */
export function readEntryHeader(bytes: Uint8Array, start: number): EntryHeader {
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

/** Serialize an entry header (the inverse of {@link readEntryHeader}). */
export function encodeEntryHeader(type: number, size: number): Uint8Array {
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
export function readOfsDeltaOffset(
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

/** The two varints a delta stream opens with: base size, then result size. */
export interface DeltaHeader {
	/** Size of the object the delta is written against. */
	readonly baseSize: number;
	/** Size of the object the delta reconstructs. */
	readonly resultSize: number;
	/** Bytes the two varints occupy. */
	readonly length: number;
}

/** Read the base-128 little-endian varint at `start`, 7 bits per byte. */
function readVarint(
	bytes: Uint8Array,
	start: number,
): { value: number; length: number } {
	let at = start;
	let byte = bytes[at++] as number;
	let value = byte & 0x7f;
	let shift = 7;
	while (byte & 0x80) {
		byte = bytes[at++] as number;
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	}
	return { value, length: at - start };
}

/**
 * Read the delta header that follows an `OFS_DELTA` / `REF_DELTA` entry's own
 * header (and, for `REF_DELTA`, its 20-byte base id): the size of the object
 * being modified, then the size of the result. The result size is the answer
 * {@link ObjectSize} exists to get — it is the only place a deltified object's
 * real length is recorded.
 */
export function readDeltaHeader(bytes: Uint8Array, start: number): DeltaHeader {
	const base = readVarint(bytes, start);
	const result = readVarint(bytes, start + base.length);
	return {
		baseSize: base.value,
		resultSize: result.value,
		length: base.length + result.length,
	};
}
