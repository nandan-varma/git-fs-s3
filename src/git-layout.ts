/**
 * Typed classification of paths inside a git directory, so callers can
 * reason about "a ref", "a loose object" or "the pack listing" as values
 * instead of matching path strings against patterns.
 *
 * Edge-compatible: no node: imports.
 */

import { type PackFileName, parsePackFileName } from "./pack-files.js";

/** What a gitdir-relative path refers to. Listing prefixes end in `/`. */
export type GitdirEntry =
	| { readonly kind: "head" }
	| { readonly kind: "config" }
	/** A ref file (`refs/heads/main`) or a refs listing (`refs/heads/`). */
	| { readonly kind: "refs"; readonly path: string }
	/** The `objects/` listing. */
	| { readonly kind: "objects-dir" }
	/** The `objects/pack/` listing. */
	| { readonly kind: "pack-dir" }
	| { readonly kind: "pack-file"; readonly file: PackFileName }
	| { readonly kind: "loose-object"; readonly oid: string }
	| { readonly kind: "other" };

const HEX = new Set("0123456789abcdef");

function isHex(value: string, length: number): boolean {
	if (value.length !== length) return false;
	for (const char of value) if (!HEX.has(char)) return false;
	return true;
}

/** Classify a path relative to a gitdir (no leading slash). */
export function classifyGitdirPath(path: string): GitdirEntry {
	const segments = path.split("/");
	const [first, second, third, ...rest] = segments;
	if (segments.length === 1) {
		if (first === "HEAD") return { kind: "head" };
		if (first === "config") return { kind: "config" };
		if (first === "refs") return { kind: "refs", path };
		return { kind: "other" };
	}
	if (first === "refs") return { kind: "refs", path };
	if (first !== "objects" || second === undefined) return { kind: "other" };
	if (segments.length === 2 && second === "") return { kind: "objects-dir" };
	if (second === "pack" && third !== undefined && rest.length === 0) {
		if (third === "") return { kind: "pack-dir" };
		const file = parsePackFileName(third);
		return file ? { kind: "pack-file", file } : { kind: "other" };
	}
	if (
		third !== undefined &&
		rest.length === 0 &&
		isHex(second, 2) &&
		isHex(third, 38)
	) {
		return { kind: "loose-object", oid: second + third };
	}
	return { kind: "other" };
}

/**
 * Whether reads of this entry can change between pushes: refs, `HEAD`, and
 * the object/pack listings. Everything else is content-addressed (objects)
 * or written once (config, a given pack file name).
 */
export function isMutableGitdirEntry(entry: GitdirEntry): boolean {
	switch (entry.kind) {
		case "head":
		case "refs":
		case "objects-dir":
		case "pack-dir":
			return true;
		default:
			return false;
	}
}

/**
 * A loose-object path anywhere in the fs, split into its gitdir and oid —
 * for callers that don't know where the gitdir boundary is: a loose object
 * is always `<gitdir>/objects/<2 hex>/<38 hex>`.
 */
export function parseLooseObjectPath(
	path: string,
): { readonly gitdir: string; readonly oid: string } | null {
	const segments = path.split("/");
	if (segments.length < 3) return null;
	const gitdirSegments = segments.slice(0, -3);
	const entry = classifyGitdirPath(segments.slice(-3).join("/"));
	if (entry.kind !== "loose-object") return null;
	return { gitdir: gitdirSegments.join("/"), oid: entry.oid };
}
