/**
 * Edge-compatible utilities replacing node:crypto, node:zlib, and Buffer.
 *
 * Every function here uses only Web APIs (SubtleCrypto, CompressionStream,
 * TextEncoder/TextDecoder) — no Node built-ins. They work on Cloudflare
 * Workers, Vercel Edge, Deno Deploy, and Node >= 18.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Encode a UTF-8 string to bytes. */
export function encodeUtf8(data: string): Uint8Array {
	return textEncoder.encode(data);
}

/** Decode bytes as UTF-8. */
export function decodeUtf8(data: Uint8Array): string {
	return textDecoder.decode(data);
}

/** Decode bytes as ASCII. */
export function decodeAscii(data: Uint8Array): string {
	let s = "";
	for (let i = 0; i < data.length; i++)
		s += String.fromCharCode(data[i] as number);
	return s;
}

// ---------------------------------------------------------------------------
// Array manipulation
// ---------------------------------------------------------------------------

/** Concatenate any number of Uint8Arrays into one. */
export function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** Extract a subarray (alias for Uint8Array.subarray for readability). */
export function slice(
	data: Uint8Array,
	start: number,
	end?: number,
): Uint8Array {
	return data.subarray(start, end);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Uint8Array → lowercase hex string. */
export function toHex(data: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < data.length; i++)
		hex += (data[i] as number).toString(16).padStart(2, "0");
	return hex;
}

/** Uint8Array → base64 string. */
export function toBase64(data: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < data.length; i++)
		binary += String.fromCharCode(data[i] as number);
	return btoa(binary);
}

/** Hex string → Uint8Array. */
export function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/** SHA-1 hash via Web Crypto API. Returns a hex string. */
export async function sha1(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? encodeUtf8(data) : data;
	const hash = await globalThis.crypto.subtle.digest("SHA-1", bytes);
	return toHex(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Deflate compress via the CompressionStream Web API.
 * Falls back to throwing if CompressionStream is unavailable (very old runtimes).
 */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Binary detection (replaces Buffer.includes(0) pattern)
// ---------------------------------------------------------------------------

/** Check if a Uint8Array contains a null byte. */
export function hasNullByte(data: Uint8Array): boolean {
	return data.includes(0);
}

/**
 * Read a blob as text or binary metadata — the edge-compatible replacement
 * for the `Buffer.from(blob)` pattern used throughout diff.ts and history.ts.
 */
export function readBlobContent(blob: Uint8Array): {
	isBinary: boolean;
	text: string;
	bytes: Uint8Array;
} {
	const isBinary = hasNullByte(blob);
	return {
		isBinary,
		text: isBinary ? "" : decodeUtf8(blob),
		bytes: blob,
	};
}
