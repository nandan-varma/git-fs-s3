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
 * Walk the full object graph from `startOids`, returning every reachable
 * oid. Concurrent traversal paths are deduplicated promise-per-oid; a
 * missing object is retried once, then reported through `hooks.onWarn` and
 * reflected in `complete: false`.
 */
export async function collectReachableOids(
	repo: Repo,
	startOids: string[],
	hooks?: HttpHooks,
): Promise<ReachabilityResult> {
	const seen = new Set<string>();
	let complete = true;
	const promises = new Map<string, Promise<void>>();

	async function readAndVisitChildren(oid: string): Promise<void> {
		const obj = await git.readObject({ ...repo, oid });
		// Add to seen only after a successful read so failed reads are excluded
		// from any pack built from this set.
		seen.add(oid);
		let children: string[] = [];
		if (obj.type === "commit") {
			const { commit } = await git.readCommit({ ...repo, oid });
			children = [commit.tree, ...commit.parent];
		} else if (obj.type === "tree") {
			const { tree } = await git.readTree({ ...repo, oid });
			children = tree.map((e) => e.oid);
		} else if (obj.type === "tag") {
			const { tag } = await git.readTag({ ...repo, oid });
			children = [tag.object];
		}
		await Promise.all(children.map(visit));
	}

	function visit(oid: string): Promise<void> {
		const existing = promises.get(oid);
		if (existing) return existing;

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

	await Promise.all(startOids.map(visit));
	return { oids: Array.from(seen), complete };
}
