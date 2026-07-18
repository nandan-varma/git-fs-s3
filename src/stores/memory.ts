import type {
	ListOptions,
	ListResult,
	ObjectStat,
	ObjectStore,
} from "../types.js";

/**
 * In-memory {@link ObjectStore}. Useful for tests, examples, and ephemeral
 * repositories; also the reference implementation for the list/delimiter
 * semantics other stores must match.
 */
export class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, Uint8Array>();

	async get(key: string): Promise<Uint8Array | null> {
		const data = this.objects.get(key);
		return data ? data.slice() : null;
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		this.objects.set(key, data.slice());
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async head(key: string): Promise<ObjectStat | null> {
		const data = this.objects.get(key);
		return data ? { size: data.byteLength } : null;
	}

	async list(prefix: string, options?: ListOptions): Promise<ListResult> {
		const delimiter = options?.delimiter;
		const limit = options?.limit ?? Number.POSITIVE_INFINITY;
		const objects: ListResult["objects"] = [];
		const prefixes = new Set<string>();

		for (const [key, data] of this.objects) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (delimiter !== undefined) {
				const idx = rest.indexOf(delimiter);
				if (idx !== -1) {
					prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
				} else {
					objects.push({ key, size: data.byteLength });
				}
			} else {
				objects.push({ key, size: data.byteLength });
			}
			if (objects.length + prefixes.size >= limit) break;
		}

		return { objects, prefixes: [...prefixes] };
	}

	/** Number of stored objects (test convenience, not part of ObjectStore). */
	get size(): number {
		return this.objects.size;
	}
}
