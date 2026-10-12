/**
 * Typed view of a git `objects/pack` directory listing.
 *
 * Every pack is a set of sibling files sharing one base name
 * (`pack-<hash>.pack`, `.idx`, and optionally `.keep`/`.bitmap`/`.rev`).
 * Parsing names once into {@link PackFileName} lets callers group, filter and
 * rename by kind instead of re-matching filename strings at each call site.
 *
 * Edge-compatible: no node: imports.
 */

/** Every file kind git writes into `objects/pack`. */
export const PACK_FILE_KINDS = [
	"pack",
	"idx",
	"keep",
	"bitmap",
	"rev",
] as const;
export type PackFileKind = (typeof PACK_FILE_KINDS)[number];

/** Kinds isomorphic-git actually reads; the rest are git-CLI accelerators. */
export const READABLE_PACK_FILE_KINDS: ReadonlySet<PackFileKind> = new Set([
	"pack",
	"idx",
]);

export interface PackFileName {
	/** Shared base of a pack's sibling files, e.g. `pack-1a2b…`. */
	readonly base: string;
	readonly kind: PackFileKind;
	/** The file name as listed, e.g. `pack-1a2b….idx`. */
	readonly name: string;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(PACK_FILE_KINDS);

function isPackFileKind(value: string): value is PackFileKind {
	return KNOWN_KINDS.has(value);
}

/** Parse a pack-directory entry; `null` for anything git didn't put there. */
export function parsePackFileName(name: string): PackFileName | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const kind = name.slice(dot + 1);
	if (!isPackFileKind(kind)) return null;
	return { base: name.slice(0, dot), kind, name };
}

/** File name of the `kind` sibling of the pack with this base name. */
export function packFileName(base: string, kind: PackFileKind): string {
	return `${base}.${kind}`;
}

/** Parse a directory listing, dropping entries that aren't pack files. */
export function parsePackDirectory(entries: readonly string[]): PackFileName[] {
	return entries
		.map(parsePackFileName)
		.filter((file): file is PackFileName => file !== null);
}
