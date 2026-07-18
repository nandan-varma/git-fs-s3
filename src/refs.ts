/**
 * Git ref-name validation, mirroring isomorphic-git's own internal `isValidRef`
 * character-class rules (the check `git.branch` and top-level `git.writeRef`
 * run before touching disk).
 *
 * Several of isomorphic-git's OTHER ref-touching primitives — `git.commit`,
 * `git.merge`, `git.deleteBranch`, and top-level `git.resolveRef`/
 * `git.deleteRef` — do NOT run this check internally: they resolve straight
 * through `fs.write`/`fs.rm(join(gitdir, ref))` with no jail to the gitdir.
 * On a shared-storage server (many repos under one prefix or base directory),
 * every branch/ref name that originates from request input must be validated
 * against these predicates before it reaches any of those primitives —
 * otherwise a `"../"`-laden name lets a caller with write access to any single
 * repo read, corrupt, or delete another repo's ref/object files.
 */

const BAD_REF_COMPONENT =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what git's own ref-name rules reject — this needs to match the same range.
	/(^|[/.])([/.]|$)|^@$|@\{|[\x00-\x20\x7f~^:?*[\\]|\.lock(\/|$)/;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Validates a fully-qualified ref (must start with refs/heads/ or refs/tags/). */
export function isSafeFullRefName(ref: string): boolean {
	if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) {
		return false;
	}
	return !BAD_REF_COMPONENT.test(ref);
}

/**
 * Validates a bare branch name (no refs/ prefix). Rejects anything that looks
 * like a full ref path — a name of `"refs/heads/x"` would otherwise sail
 * through unprefixed at call sites that build `refs/heads/${name}` themselves
 * (doubling the prefix into something that still resolves), or be used as-is
 * at call sites that pass a name already containing `"refs/"` straight
 * through. Also rejects 40-hex SHA-shaped values so a stored branch name can
 * never be ambiguous with a commit SHA at write time; use
 * {@link isSafeRefName} on read paths that accept both shapes.
 */
export function isSafeBranchName(name: string): boolean {
	if (!name || name.startsWith("refs/") || name === "HEAD") return false;
	if (FULL_SHA_RE.test(name)) return false;
	return !BAD_REF_COMPONENT.test(name);
}

/** True for a full 40-hex-char commit SHA — the shape {@link isSafeBranchName} deliberately rejects. */
export function isFullSha(value: string): boolean {
	return FULL_SHA_RE.test(value);
}

/**
 * Validates a "ref" field that may name either a branch or a commit SHA it's
 * pinned to — the shape read-path route params take (permalinks, raw links).
 * Both shapes still go through the traversal check.
 */
export function isSafeRefName(value: string): boolean {
	return isSafeBranchName(value) || isFullSha(value);
}

/**
 * Validates a repo-relative file path from request input: relative, no `..`
 * segments, no `.git/` prefix, no null bytes. Use this anywhere a path
 * segment comes straight off a URL or form field rather than re-deriving the
 * checks ad hoc.
 */
export function isSafeRepoPath(p: string): boolean {
	if (p.startsWith("/")) return false;
	if (p.split("/").some((segment) => segment === "..")) return false;
	if (/^\.git(\/|$)/i.test(p)) return false;
	if (p.includes("\0")) return false;
	return true;
}

/**
 * Qualify a bare branch name to `refs/heads/<name>` before handing it to
 * isomorphic-git. `resolveRef`/`expand` try several candidate paths in
 * sequence for a bare name — `ref`, `refs/ref`, `refs/tags/ref`,
 * `refs/heads/ref`, … — missing (and, against object storage, paying a real
 * round trip for) the first three every time. For a branch-only ref model,
 * skip straight to the winner. Left untouched: already-qualified refs,
 * `"HEAD"` (its own first candidate, already optimal), and 40-hex oids
 * (resolved locally by isomorphic-git with no I/O at all).
 */
export function qualifyBranchRef(ref: string): string {
	if (ref.startsWith("refs/") || ref === "HEAD" || FULL_SHA_RE.test(ref)) {
		return ref;
	}
	return `refs/heads/${ref}`;
}
