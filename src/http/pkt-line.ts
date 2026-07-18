/**
 * Git pkt-line framing (smart HTTP protocol wire format).
 *
 * Edge-compatible: uses Uint8Array instead of Buffer.
 */

import { concat, decodeAscii, decodeUtf8, encodeUtf8 } from "../edge-utils.js";

/** Flush packet: exactly four zero bytes. */
export const FLUSH: Uint8Array<ArrayBuffer> = new Uint8Array([
	0x30, 0x30, 0x30, 0x30,
]); // "0000"

/** Frame a UTF-8 string as one pkt-line. */
export function pktLine(data: string): Uint8Array<ArrayBuffer> {
	const body = encodeUtf8(data);
	const len = (body.length + 4).toString(16).padStart(4, "0");
	return concat(encodeUtf8(len), body);
}

/** Frame raw bytes as one pkt-line. */
export function pktLineBuffer(body: Uint8Array): Uint8Array<ArrayBuffer> {
	const len = (body.length + 4).toString(16).padStart(4, "0");
	return concat(encodeUtf8(len), body);
}

/** Decode pkt-lines to strings; `null` marks a flush-pkt. Stops on garbage. */
export function parsePktLines(buf: Uint8Array): Array<string | null> {
	const lines: Array<string | null> = [];
	let pos = 0;
	while (pos + 4 <= buf.length) {
		const len = Number.parseInt(decodeAscii(buf.subarray(pos, pos + 4)), 16);
		if (len === 0) {
			lines.push(null);
			pos += 4;
		} else if (len >= 4) {
			lines.push(decodeUtf8(buf.subarray(pos + 4, pos + len)));
			pos += len;
		} else {
			break;
		}
	}
	return lines;
}

/**
 * Per the git protocol, once side-band-64k has been negotiated, packfile
 * bytes in the upload-pack response must be chunked into pkt-lines each
 * prefixed with a control byte (0x01 = packfile data), terminated by a
 * flush-pkt. Without this, clients that don't special-case "no side-band" —
 * e.g. isomorphic-git's GitSideBand.demux, which always treats the response
 * as side-band-framed — misparse the raw packfile bytes as bogus pkt-line
 * length headers and spin forever. (Native `git` tolerates a raw unframed
 * stream when side-band isn't negotiated, so this only surfaces with
 * isomorphic-git as the HTTP client.)
 */
const SIDE_BAND_MAX_CHUNK = 65515;

export function sideBandPackfile(
	packData: Uint8Array,
): Uint8Array<ArrayBuffer> {
	const parts: Uint8Array[] = [];
	for (
		let offset = 0;
		offset < packData.length;
		offset += SIDE_BAND_MAX_CHUNK
	) {
		const chunk = packData.subarray(offset, offset + SIDE_BAND_MAX_CHUNK);
		parts.push(pktLineBuffer(concat(new Uint8Array([1]), chunk)));
	}
	parts.push(FLUSH);
	return concat(...parts);
}
