import git from "isomorphic-git";
import type { Repo } from "../ops/types.js";
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

	async function readAndVisitChildren(oid: string): Promise<void> {
		const obj = await git.readObject({ ...repo, oid });
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
