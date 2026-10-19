import type { ObjectStore } from "./types.js";

const BATCH = 20;

async function inBatches<T>(
	items: T[],
	fn: (item: T) => Promise<void>,
): Promise<void> {
	for (let i = 0; i < items.length; i += BATCH) {
		await Promise.all(items.slice(i, i + BATCH).map(fn));
	}
}

/**
 * Delete every object under `prefix` (one paginated LIST, then batched
 * deletes). Returns the number of objects deleted. Callers serialise against
 * concurrent writers (e.g. a repository lock) and invalidate any cache
 * layered above `store`.
 */
export async function deletePrefix(
	store: ObjectStore,
	prefix: string,
): Promise<number> {
	const { objects } = await store.list(prefix);
	await inBatches(objects, (object) => store.delete(object.key));
	return objects.length;
}

export interface MovePrefixOptions {
	/**
	 * Copy one object, e.g. a store's server-side `copy` (no bytes pass through
	 * this process). Defaults to `get` + `put` on `store`.
	 */
	copy?: (fromKey: string, toKey: string) => Promise<void>;
}

/**
 * Move every object under `from` to the same relative key under `to`: copy
 * everything first, then delete the old keys only once every copy succeeded,
 * so a failed copy leaves the source untouched (a partial destination may
 * remain; call {@link deletePrefix} on it to clean up). Returns the number of
 * objects moved. `from` and `to` must not overlap.
 */
export async function movePrefix(
	store: ObjectStore,
	from: string,
	to: string,
	options: MovePrefixOptions = {},
): Promise<number> {
	if (from.startsWith(to) || to.startsWith(from)) {
		throw new Error(`movePrefix: prefixes overlap (${from} -> ${to})`);
	}
	const copy =
		options.copy ??
		(async (fromKey: string, toKey: string) => {
			const data = await store.get(fromKey);
			if (data) await store.put(toKey, data);
		});
	const { objects } = await store.list(from);
	await inBatches(objects, (object) =>
		copy(object.key, to + object.key.slice(from.length)),
	);
	await inBatches(objects, (object) => store.delete(object.key));
	return objects.length;
}
