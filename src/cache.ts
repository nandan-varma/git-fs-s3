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
	/** Entry time-to-live in milliseconds. Default 60 000. */
	ttlMs?: number;
	/**
	 * Also cache "key does not exist" results. Loose-object probes on packed
	 * repositories are almost always misses, so this saves many round trips —
	 * but only enable it when a single process is the only writer, otherwise
	 * another instance's push can be masked for up to `ttlMs`.
	 */
	cacheMisses?: boolean;
}

const MISS = Symbol("miss");
type CacheEntry = Uint8Array | typeof MISS;

/**
 * Wrap an {@link ObjectStore} with an in-process LRU read cache.
 *
 * Git object keys are content-addressed and therefore immutable, which makes
 * them ideal cache entries; mutable keys (refs, packed-refs) are bounded by
 * `ttlMs`. Writes and deletes through this wrapper invalidate their key.
 * List calls are never cached.
 */
export function createCachedStore(
	store: ObjectStore,
	options: CacheOptions = {},
): ObjectStore {
	const ttl = options.ttlMs ?? 60_000;
	const cacheMisses = options.cacheMisses ?? false;
	const cache = new LRUCache<string, CacheEntry>({
		maxSize: options.maxBytes ?? 50 * 1024 * 1024,
		sizeCalculation: (value) => (value === MISS ? 1 : value.byteLength || 1),
		ttl,
	});

	return {
		async get(key: string): Promise<Uint8Array | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				return cached === MISS ? null : cached.slice();
			}
			const data = await store.get(key);
			if (data !== null) {
				cache.set(key, data.slice());
			} else if (cacheMisses) {
				cache.set(key, MISS);
			}
			return data;
		},

		async put(key: string, data: Uint8Array): Promise<void> {
			await store.put(key, data);
			cache.set(key, data.slice());
		},

		async delete(key: string): Promise<void> {
			await store.delete(key);
			if (cacheMisses) {
				cache.set(key, MISS);
			} else {
				cache.delete(key);
			}
		},

		async head(key: string): Promise<ObjectStat | null> {
			const cached = cache.get(key);
			if (cached !== undefined) {
				return cached === MISS ? null : { size: cached.byteLength };
			}
			return store.head(key);
		},

		list(prefix: string, listOptions?: ListOptions): Promise<ListResult> {
			return store.list(prefix, listOptions);
		},
	};
}
