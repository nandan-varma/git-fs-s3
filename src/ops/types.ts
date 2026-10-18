import type git from "isomorphic-git";

/** The fs shape isomorphic-git accepts, derived from its own signatures. */
export type IsoGitFs = Parameters<typeof git.readTree>[0]["fs"];

/**
 * A repository handle: everything isomorphic-git needs to address one bare
 * repo. Create it once per request (sharing `cache` across calls is what lets
 * isomorphic-git reuse parsed pack indexes) and pass it to every op.
 */
export interface Repo {
	fs: IsoGitFs;
	gitdir: string;
	/** isomorphic-git's shared parse cache — strongly recommended per repo. */
	cache?: object;
}

/**
 * Key/value store for memoizing expensive walk results (commit logs, tree
 * listings, per-path history). Keys are namespaced `kind:gitdir:headSha:…`,
 * so entries self-invalidate on push (new head, new key); evict
 * {@link resultKeyPrefixes} to drop a repo's superseded entries early.
 * Values are always objects (arrays or records).
 */
export interface ResultCache {
	get<T extends object>(key: string): T | null | undefined;
	set(key: string, value: object): void;
}

/** Optional instrumentation hooks accepted by every op. */
export interface OpsHooks {
	resultCache?: ResultCache;
	/** Wrap a timed sub-step (network walk, tree listing). Default: run directly. */
	step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
	/** Diagnostic sink for cache hit/miss and walk summaries. */
	onNote?: (message: string) => void;
	/**
	 * Warm every pack (e.g. `GitFs.prefetchPacks`) before a cache-miss read,
	 * so a sequential walk doesn't discover packs one round trip at a time.
	 */
	prefetch?: () => Promise<void>;
}

export const runStep = <T>(
	hooks: OpsHooks | undefined,
	label: string,
	fn: () => Promise<T>,
): Promise<T> => (hooks?.step ? hooks.step(label, fn) : fn());

/**
 * The result-cache key prefixes holding entries for `gitdir` — evict these
 * from your {@link ResultCache} when the repo's storage was rewritten outside
 * a normal push (rename, repack).
 */
export function resultKeyPrefixes(gitdir: string): string[] {
	return [
		`commitlog:${gitdir}:`,
		`tree:${gitdir}:`,
		`last-commits:${gitdir}:`,
		`file-history:${gitdir}:`,
	];
}
