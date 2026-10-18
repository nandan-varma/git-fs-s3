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

/**
 * Encode a UTF-8 string to bytes.
 *
 * Return type pinned to `Uint8Array<ArrayBuffer>` (not the bare `Uint8Array`,
 * whose default type argument differs across TypeScript versions) so it's
 * always assignable to Fetch API `BodyInit` regardless of a consumer's own
 * TypeScript/lib version.
 */
export function encodeUtf8(data: string): Uint8Array<ArrayBuffer> {
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
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
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
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
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
export async function sha1(
	data: Uint8Array<ArrayBuffer> | string,
): Promise<string> {
	const bytes = typeof data === "string" ? encodeUtf8(data) : data;
	const hash = await globalThis.crypto.subtle.digest("SHA-1", bytes);
	return toHex(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/** Deflate (zlib) via the CompressionStream Web API. */
export async function deflate(
	data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	// Response, not Blob.stream(): some Blob implementations (jsdom's) have
	// no stream().
	const stream = (new Response(data).body as ReadableStream).pipeThrough(
		new CompressionStream("deflate"),
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The first `enough` bytes of a deflate stream, given a prefix of that stream.
 *
 * Deflate emits output as it consumes input, so a bounded compressed prefix
 * yields a bounded uncompressed prefix — which is how a delta entry's header
 * (the only place its reconstructed size is recorded) can be read without
 * inflating the whole object. The prefix ends mid-symbol by construction, so
 * the stream errors after the bytes we wanted have already arrived; that error
 * carries no information and is not propagated.
 *
 * Returns `null` when fewer than `enough` bytes could be recovered, so a caller
 * distinguishes "not readable from this prefix" from a zero-length answer.
 */
export async function inflatePrefix(
	compressed: Uint8Array<ArrayBuffer>,
	enough: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const stream = (new Response(compressed).body as ReadableStream).pipeThrough(
		new DecompressionStream("deflate"),
	);
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < enough) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
	} catch {
		// Expected: the compressed prefix is truncated. Whatever was emitted
		// before that is what this returns.
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (total === 0) return null;
	return concat(...chunks.map((chunk) => new Uint8Array(chunk)));
}

/** Inflate (zlib) via the DecompressionStream Web API. */
export async function inflate(
	data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const stream = (new Response(data).body as ReadableStream).pipeThrough(
		new DecompressionStream("deflate"),
	);
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
