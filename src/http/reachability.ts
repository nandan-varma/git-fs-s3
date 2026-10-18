import git from "isomorphic-git";
import type { Repo } from "../ops/types.js";
import { createSemaphore } from "../semaphore.js";
import type { HttpHooks } from "./types.js";

export interface ReachabilityResult {
	oids: string[];
	/**
	 * False if any object in the graph couldn't be read — repack uses this
	 * (not a raw object-count comparison) to decide whether it's safe to
	 * delete old packs: counts alone can't distinguish "everything read fine"
	 * from "some objects silently failed".
	 */
	complete: boolean;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A read landing in the gap between a repack's new consolidated pack being
 * uploaded and the stale-pack cleanup finishing can transiently miss an
 * object that is not actually lost — it exists in the new pack the whole
 * time; the reader's cached pack listing was just taken mid-transition. One
 * retry after a short delay is enough to observe the consistent listing.
 */
const MISSING_OBJECT_RETRY_DELAY_MS = 200;

/**
 * In-flight object reads admitted by one {@link collectReachableOids} walk.
 * High enough that a normal tree's reads stay pipelined (the walk is
 * latency-bound, not bandwidth-bound), low enough that a tree with tens of
 * thousands of entries can't fan out into that many simultaneous reads from
 * one request and exhaust sockets, memory, or the store's rate limit.
 */
export const MAX_CONCURRENT_READS = 16;

/**
 * Walk the object graph from `startOids`, returning every reachable oid.
 * Concurrent traversal paths are deduplicated promise-per-oid; a missing
 * object is retried once, then reported through `hooks.onWarn` and
 * reflected in `complete: false`.
 *
 * `haveOids` bounds the walk: any oid in this set is assumed already
 * verified (it was reachable from a ref that existed before this call) and
 * is recorded in `seen` without being read or descended into. Without a
 * boundary, every call re-walks the *entire* history from scratch — for
 * receive-pack validation (see receive-pack.ts) that means every push pays
 * for reading every object in the repo, not just the ones it introduced,
 * and one transient read failure anywhere in that whole history rejects an
 * otherwise-valid push.
 *
 * Commits, trees and tags are read once each (parsed). Blobs have no
 * children, so `verifyBlobs: false` records a blob from its tree entry
 * without reading (and inflating) it — for callers that read every blob
 * themselves afterwards anyway, like upload-pack's `packObjects`. Leave it
 * true wherever the walk *is* the existence check (receive-pack, repack).
 *
 * Object reads are bounded by one shared {@link MAX_CONCURRENT_READS}
 * semaphore for the whole walk, held only for the read itself — not per
 * level, since the walk recurses and a per-level limit would still multiply
 * with depth, and not across the child recursion, which would deadlock a wide
 * tree once every permit belonged to a parent awaiting its children.
 */
export async function collectReachableOids(
	repo: Repo,
	startOids: string[],
	hooks?: HttpHooks,
	haveOids?: ReadonlySet<string> | readonly string[],
	options?: { verifyBlobs?: boolean },
): Promise<ReachabilityResult> {
	const verifyBlobs = options?.verifyBlobs ?? true;
	const have = haveOids instanceof Set ? haveOids : new Set(haveOids ?? []);
	const seen = new Set<string>();
	let complete = true;
	const promises = new Map<string, Promise<void>>();
	const reads = createSemaphore(MAX_CONCURRENT_READS);

	async function readAndVisitChildren(oid: string): Promise<void> {
		const obj = await reads.run(() => git.readObject({ ...repo, oid }));
		seen.add(oid);
		const children: [string, string | undefined][] = [];
		if (obj.type === "commit") {
			const commit = obj.object as { tree: string; parent: string[] };
			children.push([commit.tree, "tree"]);
			for (const parent of commit.parent) children.push([parent, "commit"]);
		} else if (obj.type === "tree") {
			const tree = obj.object as { oid: string; type: string }[];
			for (const entry of tree) {
				// Gitlinks (submodules, mode 160000) point at commits in another
				// repository; git never stores them here, so following one would
				// report a "missing" object and fail every walk over that history.
				if (entry.type === "commit") continue;
				children.push([entry.oid, entry.type]);
			}
		} else if (obj.type === "tag") {
			children.push([(obj.object as { object: string }).object, undefined]);
		}
		await Promise.all(children.map(([child, type]) => visit(child, type)));
	}

	function visit(oid: string, type?: string): Promise<void> {
		const existing = promises.get(oid);
		if (existing) return existing;

		if (have.has(oid) || (type === "blob" && !verifyBlobs)) {
			seen.add(oid);
			const p = Promise.resolve();
			promises.set(oid, p);
			return p;
		}

		const p = (async () => {
			try {
				await readAndVisitChildren(oid);
			} catch {
				try {
					await delay(MISSING_OBJECT_RETRY_DELAY_MS);
					await readAndVisitChildren(oid);
				} catch (err) {
					complete = false;
					hooks?.onWarn?.(`missing object ${oid}`, err);
				}
			}
		})();

		promises.set(oid, p);
		return p;
	}

	await Promise.all(startOids.map((oid) => visit(oid)));
	return { oids: Array.from(seen), complete };
}

/**
 * Commit-only ancestry walk: every commit reachable from `startOids`
 * (annotated tags peeled), stopping at — and not descending into — commits in
 * `stopAt`. Reads commit objects only, never trees or blobs, so it costs a
 * fraction of {@link collectReachableOids} over the same history. Start oids
 * that don't exist (or aren't commits/tags) are skipped. Returns the commits
 * walked and the `stopAt` commits the walk ran into.
 */
export async function collectCommitAncestry(
	repo: Repo,
	startOids: readonly string[],
	stopAt?: ReadonlySet<string>,
): Promise<{ commits: Set<string>; boundary: Set<string> }> {
	const commits = new Set<string>();
	const boundary = new Set<string>();
	const queued = new Set<string>();
	let frontier = [...new Set(startOids)];
	const BATCH = 50;
	while (frontier.length > 0) {
		const next: string[] = [];
		for (let i = 0; i < frontier.length; i += BATCH) {
			await Promise.all(
				frontier.slice(i, i + BATCH).map(async (oid) => {
					if (stopAt?.has(oid)) {
						boundary.add(oid);
						return;
					}
					const object = await git
						.readObject({ ...repo, oid })
						.catch(() => null);
					if (object?.type === "tag") {
						const target = (object.object as { object: string }).object;
						if (!queued.has(target)) {
							queued.add(target);
							next.push(target);
						}
						return;
					}
					if (object?.type !== "commit") return;
					commits.add(oid);
					for (const parent of (object.object as { parent: string[] }).parent) {
						if (!queued.has(parent)) {
							queued.add(parent);
							next.push(parent);
						}
					}
				}),
			);
		}
		frontier = next;
	}
	return { commits, boundary };
}
