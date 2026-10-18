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
	 * Override the TTL for a specific key (get/head) or list prefix (list),
	 * in milliseconds. Return `undefined` to fall back to `ttlMs`. Git refs
	 * (`refs/heads/<branch>`, `HEAD`) are mutable — the same key's value
	 * changes on every push — unlike content-addressed object keys, which
	 * never change for a given key and are safe to cache for the full
	 * `ttlMs`. Without this, a long `ttlMs` tuned for objects also caches
	 * ref reads that long, so a warm process can keep serving a
	 * pre-push ref value for the rest of that TTL even though nothing
	 * changed *this* process's own cache (see `invalidate`) — it just never
	 * knew to. Give ref-like keys a short override (a few seconds) instead:
	 * a ref read is one small object, so re-reading it far more often than
	 * `ttlMs` is cheap, and every read downstream of a fresh ref (tree,
	 * commit, blob — all keyed by the sha it resolves to) still gets the
	 * full-length cache/coalescing benefit.
	 */
	ttlForKey?: (key: string) => number | undefined;
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
	/**
	 * Return defensive copies from `get` (and copy on admit), so a caller
	 * mutating returned bytes can't corrupt the cache. Default true. Set
	 * false when no reader mutates results (isomorphic-git doesn't): every
	 * hit otherwise copies the whole entry, which for packfiles is megabytes
	 * per read.
	 */
	copy?: boolean;
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
	const ttlForKey = options.ttlForKey;
	const cacheMisses = options.cacheMisses ?? false;
	const cacheLists = options.cacheLists ?? false;
	const coalesce = options.coalesce ?? true;
	const copy = options.copy ?? true;
	const clone = (data: Uint8Array) => (copy ? data.slice() : data);
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

	/**
	 * Bumped by every write, delete and invalidation. A backend read that
	 * started before one of those may finish after it carrying the old answer
	 * (the old bytes, or "missing" for a key that now exists); it still
	 * answers its own callers, but only a read that saw no write in between
	 * may populate the cache — otherwise a stale miss could hide a freshly
	 * written object for the whole TTL.
	 */
	let generation = 0;
	const unchangedSince = (start: number) => generation === start;

	const admit = (key: string, data: Uint8Array) => {
		if (data.byteLength <= maxEntryBytes) {
			cache.set(key, clone(data), { ttl: ttlForKey?.(key) });
		}
	};

	/** Drop list entries a write/delete at `key` may have made stale. */
	function clearStaleListEntries(key: string): void {
		for (const [listKey, entry] of listCache.entries()) {
			if (!key.startsWith(entry.prefix)) continue;
			if (entry.probe && !entry.empty) continue;
			listCache.delete(listKey);
		}
		// Readers arriving after this write must not join a listing that
		// started before it.
		for (const listKey of pendingLists.keys()) {
			const prefix = listKey.split("|").slice(2).join("|");
			if (key.startsWith(prefix)) pendingLists.delete(listKey);
		}
	}

	/** A write to `key` happened: no in-flight read of it may be joined or cached. */
	function noteWrite(key: string): void {
		generation++;
		pendingGets.delete(key);
		pendingHeads.delete(key);
	}

	function coalesced<T>(
		pending: Map<string, Promise<T>>,
		key: string,
		fn: () => Promise<T>,
	): Promise<T> {
		if (!coalesce) return fn();
		const inflight = pending.get(key);
		if (inflight !== undefined) return inflight;
		const p = fn().finally(() => {
			if (pending.get(key) === p) pending.delete(key);
		});
		pending.set(key, p);
		return p;
	}

	return {
		async get(key: string): Promise<Uint8Array | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				onHit?.(key);
				return cached === MISS ? null : clone(cached);
			}
			const data = await coalesced(pendingGets, key, async () => {
				onMiss?.(key);
				const start = generation;
				const fetched = await store.get(key);
				if (unchangedSince(start)) {
					if (fetched !== null) {
						admit(key, fetched);
					} else if (cacheMisses) {
						cache.set(key, MISS, { ttl: ttlForKey?.(key) });
					}
				}
				return fetched;
			});
			return data === null ? null : clone(data);
		},

		async put(key: string, data: Uint8Array): Promise<void> {
			noteWrite(key);
			try {
				await store.put(key, data);
			} finally {
				// Even a failed put may have landed; never keep serving the
				// pre-write answer for this key.
				noteWrite(key);
				cache.delete(key);
				clearStaleListEntries(key);
			}
			admit(key, data);
		},

		async delete(key: string): Promise<void> {
			noteWrite(key);
			try {
				await store.delete(key);
			} finally {
				noteWrite(key);
				cache.delete(key);
				clearStaleListEntries(key);
			}
			if (cacheMisses) {
				cache.set(key, MISS, { ttl: ttlForKey?.(key) });
			} else {
				cache.delete(key);
			}
		},

		async head(key: string): Promise<ObjectStat | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				onHit?.(key);
				return cached === MISS ? null : { size: cached.byteLength };
			}
			return coalesced(pendingHeads, key, async () => {
				onMiss?.(key);
				const start = generation;
				const stat = await store.head(key);
				if (stat === null && cacheMisses && unchangedSince(start)) {
					cache.set(key, MISS, { ttl: ttlForKey?.(key) });
				}
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
				const start = generation;
				const fetched = await store.list(prefix, listOptions);
				if (!unchangedSince(start)) return fetched;
				listCache.set(
					listKey,
					{
						result: copyListResult(fetched),
						prefix,
						probe: listOptions?.limit === 1,
						empty:
							fetched.objects.length === 0 && fetched.prefixes.length === 0,
					},
					{ ttl: ttlForKey?.(prefix) },
				);
				return fetched;
			});
			return copyListResult(result);
		},

		invalidate(prefix: string): void {
			generation++;
			for (const key of [...pendingGets.keys()]) {
				if (key.startsWith(prefix)) pendingGets.delete(key);
			}
			for (const key of [...pendingHeads.keys()]) {
				if (key.startsWith(prefix)) pendingHeads.delete(key);
			}
			pendingLists.clear();
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
