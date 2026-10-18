/**
 * Writing packfiles: serialize whole (never deltified) objects into a pack,
 * and store a pack plus its index in a repository. Shared by repack (the
 * loose-object fallback) and packed writes (ops/packed-writes.ts).
 *
 * Edge-compatible: Web Crypto SHA-1, CompressionStream, Uint8Array only.
 */
import git from "isomorphic-git";
import {
	concat,
	deflate,
	encodeUtf8,
	fromHex,
	sha1,
	toHex,
} from "./edge-utils.js";
import { rawFs } from "./http/types.js";
import type { Repo } from "./ops/types.js";
import { packFileName } from "./pack-files.js";

export type PackObjectType = "commit" | "tree" | "blob" | "tag";

// Git pack object type bits (bits 6-4 of the header's first byte).
const PACK_OBJECT_TYPE_BITS: Record<PackObjectType, number> = {
	commit: 0b0010000,
	tree: 0b0100000,
	blob: 0b0110000,
	tag: 0b1000000,
};

// First byte: continuation bit | 3-bit type | low 4 bits of length; the rest
// of the length follows 7 bits at a time, little-endian.
function encodePackObjectHeader(
	type: PackObjectType,
	length: number,
): Uint8Array {
	const bytes: number[] = [];
	let more = length > 0b1111;
	bytes.push(
		(more ? 0b10000000 : 0) | PACK_OBJECT_TYPE_BITS[type] | (length & 0b1111),
	);
	let rest = Math.floor(length / 16);
	while (more) {
		more = rest > 0b01111111;
		bytes.push((more ? 0b10000000 : 0) | (rest & 0b01111111));
		rest = Math.floor(rest / 128);
	}
	return new Uint8Array(bytes);
}

/** Git's object id: sha1("<type> <byte length>\0<content>"). */
export function hashGitObject(
	type: string,
	content: Uint8Array,
): Promise<string> {
	return sha1(concat(encodeUtf8(`${type} ${content.length}\0`), content));
}

export interface PackObject {
	type: PackObjectType;
	content: Uint8Array<ArrayBuffer>;
}

/** A version-2 pack holding `objects` as full entries, in order. */
export async function encodePack(
	objects: readonly PackObject[],
): Promise<Uint8Array<ArrayBuffer>> {
	const header = new Uint8Array(12);
	const view = new DataView(header.buffer);
	header.set(encodeUtf8("PACK"), 0);
	view.setUint32(4, 2, false);
	view.setUint32(8, objects.length, false);

	const chunks: Uint8Array[] = [header];
	const BATCH_SIZE = 100;
	for (let i = 0; i < objects.length; i += BATCH_SIZE) {
		const encoded = await Promise.all(
			objects
				.slice(i, i + BATCH_SIZE)
				.map(async (object) =>
					concat(
						encodePackObjectHeader(object.type, object.content.length),
						await deflate(object.content),
					),
				),
		);
		chunks.push(...encoded);
	}
	// The trailer is the SHA-1 of every preceding byte.
	const body = concat(...chunks);
	return concat(body, fromHex(await sha1(body)));
}

/**
 * A pack's conventional base name, `pack-<checksum>`: the trailer SHA-1 is a
 * function of the content, so two writers can never pick the same name for
 * different packs, and rewriting the same pack is idempotent.
 */
export function packBaseName(pack: Uint8Array): string {
	return `pack-${toHex(pack.subarray(pack.length - 20))}`;
}

/**
 * Store `pack` in `repo` and index it (isomorphic-git's `indexPack`, which
 * re-hashes every object). The `.idx` is written last: a pack only becomes
 * visible to readers once its index exists. Returns the base name and the
 * oids the index lists.
 */
export async function storePack(
	repo: Repo,
	pack: Uint8Array,
): Promise<{ base: string; oids: string[] }> {
	const fsp = rawFs(repo);
	const packDir = `${repo.gitdir}/objects/pack`;
	const base = packBaseName(pack);
	await fsp.mkdir(packDir, { recursive: true });
	await fsp.writeFile(`${packDir}/${packFileName(base, "pack")}`, pack);
	const { oids } = await git.indexPack({
		...repo,
		dir: packDir,
		filepath: packFileName(base, "pack"),
	});
	return { base, oids };
}
