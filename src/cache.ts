import { LRUCache } from "lru-cache";
import type {
	ListOptions,
	ListResult,
	ObjectStat,
	ObjectStore,
} from "./types.js";

export interface CacheOptions {
	/** Maximum bytes of object data held in memory. Default 50 MiB. */
	maxBytes?: number;
	/**
	 * Largest single entry admitted to the cache. Defaults to a tenth of
	 * `maxBytes` so one huge packfile cannot evict the whole working set.
	 */
	maxEntryBytes?: number;
	/** Entry time-to-live in milliseconds. Default 60 000. */
	ttlMs?: number;
	/**
	 * Also cache "key does not exist" results. Loose-object probes on packed
	 * repositories are almost always misses, so this saves many round trips —
	 * but only enable it when a single process is the only writer, otherwise
	 * another instance's push can be masked for up to `ttlMs`.
	 */
	cacheMisses?: boolean;
	/**
	 * Also cache `list()` results (directory listings and `limit: 1`
	 * existence probes). Writes through this store keep cached listings
	 * consistent; after writing to the backend by any other means, call
	 * `invalidate()` with the affected prefix. Default false.
	 */
	cacheLists?: boolean;
	/**
	 * Collapse concurrent `get`/`head`/`list` calls for the same key into a
	 * single backend request. Default true.
	 */
	coalesce?: boolean;
	/** Called when a read is answered from cache. */
	onHit?: (key: string) => void;
	/** Called when a read has to go to the backing store. */
	onMiss?: (key: string) => void;
}

/** An {@link ObjectStore} wrapper that also supports explicit invalidation. */
export interface CachedObjectStore extends ObjectStore {
	/**
	 * Drop every cached entry — contents, misses, and listings — whose key
	 * falls under `prefix` (exact keys included). Call this after the backing
	 * store was modified by something other than this wrapper.
	 */
	invalidate(prefix: string): void;
}

const MISS = Symbol("miss");
type CacheEntry = Uint8Array | typeof MISS;

interface ListEntry {
	result: ListResult;
	/** The raw list prefix this entry describes. */
	prefix: string;
	/** True for `limit: 1` existence probes. */
	probe: boolean;
	/** True when the listing came back with no objects or prefixes. */
	empty: boolean;
}

function listEntrySize(entry: ListEntry): number {
	let size = entry.prefix.length + 16;
	for (const o of entry.result.objects) size += o.key.length + 8;
	for (const p of entry.result.prefixes) size += p.length;
	return size;
}

function copyListResult(result: ListResult): ListResult {
	return {
		objects: result.objects.map((o) => ({ ...o })),
		prefixes: [...result.prefixes],
	};
}

/**
 * Wrap an {@link ObjectStore} with an in-process LRU read cache.
 *
 * Git object keys are content-addressed and therefore immutable, which makes
 * them ideal cache entries; mutable keys (refs, packed-refs) are bounded by
 * `ttlMs`. Writes and deletes through this wrapper invalidate their key and
 * any cached listings they affect — with one asymmetry: a non-empty `limit: 1`
 * probe (a "directory exists" answer) survives writes underneath it, because
 * adding a key below a prefix cannot make that prefix stop existing, while
 * empty probes and full listings are always dropped.
 */
export function createCachedStore(
	store: ObjectStore,
	options: CacheOptions = {},
): CachedObjectStore {
	const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
	const maxEntryBytes = options.maxEntryBytes ?? Math.ceil(maxBytes / 10);
	const ttl = options.ttlMs ?? 60_000;
	const cacheMisses = options.cacheMisses ?? false;
	const cacheLists = options.cacheLists ?? false;
	const coalesce = options.coalesce ?? true;
	const onHit = options.onHit;
	const onMiss = options.onMiss;

	const cache = new LRUCache<string, CacheEntry>({
		maxSize: maxBytes,
		sizeCalculation: (value) => (value === MISS ? 1 : value.byteLength || 1),
		ttl,
	});
	const listCache = new LRUCache<string, ListEntry>({
		maxSize: Math.max(1, Math.ceil(maxBytes / 10)),
		sizeCalculation: listEntrySize,
		ttl,
	});

	const pendingGets = new Map<string, Promise<Uint8Array | null>>();
	const pendingHeads = new Map<string, Promise<ObjectStat | null>>();
	const pendingLists = new Map<string, Promise<ListResult>>();

	const admit = (key: string, data: Uint8Array) => {
		if (data.byteLength <= maxEntryBytes) cache.set(key, data.slice());
	};

	/** Drop list entries a write/delete at `key` may have made stale. */
	function clearStaleListEntries(key: string): void {
		for (const [listKey, entry] of listCache.entries()) {
			if (!key.startsWith(entry.prefix)) continue;
			if (entry.probe && !entry.empty) continue;
			listCache.delete(listKey);
		}
	}

	function coalesced<T>(
		pending: Map<string, Promise<T>>,
		key: string,
		fn: () => Promise<T>,
	): Promise<T> {
		if (!coalesce) return fn();
		const inflight = pending.get(key);
		if (inflight !== undefined) return inflight;
		const p = fn().finally(() => pending.delete(key));
		pending.set(key, p);
		return p;
	}

	return {
		async get(key: string): Promise<Uint8Array | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				onHit?.(key);
				return cached === MISS ? null : cached.slice();
			}
			const data = await coalesced(pendingGets, key, async () => {
				onMiss?.(key);
				const fetched = await store.get(key);
				if (fetched !== null) {
					admit(key, fetched);
				} else if (cacheMisses) {
					cache.set(key, MISS);
				}
				return fetched;
			});
			return data === null ? null : data.slice();
		},

		async put(key: string, data: Uint8Array): Promise<void> {
			await store.put(key, data);
			admit(key, data);
			if (data.byteLength > maxEntryBytes) cache.delete(key);
			clearStaleListEntries(key);
		},

		async delete(key: string): Promise<void> {
			await store.delete(key);
			if (cacheMisses) {
				cache.set(key, MISS);
			} else {
				cache.delete(key);
			}
			clearStaleListEntries(key);
		},

		async head(key: string): Promise<ObjectStat | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				onHit?.(key);
				return cached === MISS ? null : { size: cached.byteLength };
			}
			return coalesced(pendingHeads, key, async () => {
				onMiss?.(key);
				const stat = await store.head(key);
				if (stat === null && cacheMisses) cache.set(key, MISS);
				return stat;
			});
		},

		async list(prefix: string, listOptions?: ListOptions): Promise<ListResult> {
			if (!cacheLists) return store.list(prefix, listOptions);
			const listKey = `${listOptions?.delimiter ?? ""}|${listOptions?.limit ?? ""}|${prefix}`;
			const cached = listCache.get(listKey);
			if (cached !== undefined) {
				onHit?.(prefix);
				return copyListResult(cached.result);
			}
			const result = await coalesced(pendingLists, listKey, async () => {
				onMiss?.(prefix);
				const fetched = await store.list(prefix, listOptions);
				listCache.set(listKey, {
					result: copyListResult(fetched),
					prefix,
					probe: listOptions?.limit === 1,
					empty: fetched.objects.length === 0 && fetched.prefixes.length === 0,
				});
				return fetched;
			});
			return copyListResult(result);
		},

		invalidate(prefix: string): void {
			for (const key of cache.keys()) {
				if (key.startsWith(prefix)) cache.delete(key);
			}
			for (const [listKey, entry] of listCache.entries()) {
				if (
					entry.prefix.startsWith(prefix) ||
					prefix.startsWith(entry.prefix)
				) {
					listCache.delete(listKey);
				}
			}
		},
	};
}
