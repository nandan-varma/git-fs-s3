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
 * listings, per-file history). Keys are namespaced `kind:gitdir:headSha:…`,
 * so entries self-invalidate on push (new head, new key) — but evict entries
 * under {@link resultKeyPrefixes} after rewriting a repo's storage out of
 * band, or stale walks leak until your store's own eviction.
 */
export interface ResultCache {
	get<T>(key: string): T | null | undefined;
	set(key: string, value: unknown): void;
}

/** Optional instrumentation and tuning hooks accepted by every op. */
export interface OpsHooks {
	resultCache?: ResultCache;
	/** Wrap a timed sub-step (network walk, tree listing). Default: run directly. */
	step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
	/** Diagnostic sink for cache hit/miss and walk summaries. */
	onNote?: (message: string) => void;
	/**
	 * Wire pack prefetching (e.g. `GitFs.prefetchPacks`) here so a sequential
	 * walk doesn't pay one network round trip per commit. Called once before
	 * history walks of depth >= `prefetchMinDepth` (see below), and
	 * unconditionally on every cache-miss tree read ({@link getTreeFromRef}) —
	 * a tree read has no shallow case, it always needs at least the head
	 * commit's tree object.
	 */
	prefetch?: () => Promise<void>;
	/** Minimum walk depth before `prefetch` fires for history walks. Default 5. */
	prefetchMinDepth?: number;
}

export const runStep = <T>(
	hooks: OpsHooks | undefined,
	label: string,
	fn: () => Promise<T>,
): Promise<T> => (hooks?.step ? hooks.step(label, fn) : fn());

/**
 * The result-cache key prefixes holding entries for `gitdir` — evict these
 * from your {@link ResultCache} when the repo's storage was rewritten outside
 * a normal push (bulk sync, rename, repack cleanup).
 */
export function resultKeyPrefixes(gitdir: string): string[] {
	return [
		`commitlog:${gitdir}:`,
		`tree:${gitdir}:`,
		`commits:${gitdir}:`,
		`last-commits:${gitdir}:`,
		`file-history:${gitdir}:`,
	];
}
