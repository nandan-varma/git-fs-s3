import type { Repo } from "../ops/types.js";

/** Transport-agnostic HTTP response the handlers produce. */
export interface GitHttpResult {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

/** Optional instrumentation hooks shared by the /http handlers. */
export interface HttpHooks {
	/** Wrap a timed sub-step. Default: run directly. */
	step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
	/** Non-fatal problem sink (missing objects, failed repacks). */
	onWarn?: (message: string, error?: unknown) => void;
}

export const runStep = <T>(
	hooks: HttpHooks | undefined,
	label: string,
	fn: () => Promise<T>,
): Promise<T> => (hooks?.step ? hooks.step(label, fn) : fn());

/**
 * The raw promise-fs surface some /http paths need beyond isomorphic-git's
 * plumbing (writing an incoming pack file, listing/deleting pack files).
 * Both `node:fs` and this package's `GitFs` satisfy it via `.promises`.
 */
export interface RawFsPromises {
	readFile(path: string): Promise<Uint8Array | string>;
	writeFile(path: string, data: Uint8Array | string): Promise<void>;
	unlink(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	stat(path: string): Promise<unknown>;
}

/** Duck-type the `.promises` surface off a repo's fs. */
export function rawFs(repo: Repo): RawFsPromises {
	const fs = repo.fs as { promises?: RawFsPromises };
	if (!fs?.promises) {
		throw new TypeError(
			"This operation needs a promise fs (`fs.promises`) — node:fs and createGitFs both provide one",
		);
	}
	return fs.promises;
}
