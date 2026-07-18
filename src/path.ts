import { einval } from "./errors.js";

/**
 * Normalize an absolute-or-relative filesystem path into a storage key
 * segment: no leading/trailing slashes, `.` segments dropped, `..` resolved.
 * A `..` that would escape the root throws EINVAL — paths handed to the fs
 * must never address keys outside the configured prefix.
 */
export function normalizePath(filepath: string): string {
	const segments = filepath.split("/");
	const out: string[] = [];
	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (out.length === 0) throw einval("resolve", filepath);
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/");
}

/** Join a configured key prefix with a normalized path. */
export function toKey(prefix: string, filepath: string): string {
	const normalized = normalizePath(filepath);
	if (prefix === "") return normalized;
	return normalized === "" ? prefix : `${prefix}/${normalized}`;
}
