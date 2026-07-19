import { describe, expect, it, vi } from "vitest";
import { createCachedStore, MemoryObjectStore } from "../src/index.js";

describe("createCachedStore", () => {
	it("serves repeat reads from cache", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("k", new Uint8Array([1, 2]));
		const spy = vi.spyOn(inner, "get");
		const cached = createCachedStore(inner);

		expect(await cached.get("k")).toEqual(new Uint8Array([1, 2]));
		expect(await cached.get("k")).toEqual(new Uint8Array([1, 2]));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("does not cache misses by default", async () => {
		const inner = new MemoryObjectStore();
		const spy = vi.spyOn(inner, "get");
		const cached = createCachedStore(inner);

		expect(await cached.get("missing")).toBeNull();
		expect(await cached.get("missing")).toBeNull();
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("caches misses when enabled and invalidates on write", async () => {
		const inner = new MemoryObjectStore();
		const spy = vi.spyOn(inner, "get");
		const cached = createCachedStore(inner, { cacheMisses: true });

		expect(await cached.get("k")).toBeNull();
		expect(await cached.get("k")).toBeNull();
		expect(spy).toHaveBeenCalledTimes(1);

		await cached.put("k", new Uint8Array([9]));
		expect(await cached.get("k")).toEqual(new Uint8Array([9]));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("reflects deletes immediately", async () => {
		const inner = new MemoryObjectStore();
		const cached = createCachedStore(inner);
		await cached.put("k", new Uint8Array([1]));
		await cached.delete("k");
		expect(await cached.get("k")).toBeNull();
		expect(await cached.head("k")).toBeNull();
	});

	it("serves head from cached bodies", async () => {
		const inner = new MemoryObjectStore();
		const cached = createCachedStore(inner);
		await cached.put("k", new Uint8Array([1, 2, 3]));
		const spy = vi.spyOn(inner, "head");
		expect(await cached.head("k")).toEqual({ size: 3 });
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects entries larger than maxEntryBytes without evicting the rest", async () => {
		const inner = new MemoryObjectStore();
		const cached = createCachedStore(inner, {
			maxBytes: 1000,
			maxEntryBytes: 10,
		});
		await cached.put("small", new Uint8Array(4));
		await cached.put("huge", new Uint8Array(100));

		const getSpy = vi.spyOn(inner, "get");
		await cached.get("small");
		expect(getSpy).not.toHaveBeenCalled();
		await cached.get("huge");
		expect(getSpy).toHaveBeenCalledTimes(1);
		// And a repeat read of the huge object still goes to the backend.
		await cached.get("huge");
		expect(getSpy).toHaveBeenCalledTimes(2);
	});

	it("reports hits and misses", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("k", new Uint8Array([1]));
		const onHit = vi.fn();
		const onMiss = vi.fn();
		const cached = createCachedStore(inner, { onHit, onMiss });

		await cached.get("k");
		await cached.get("k");
		expect(onMiss).toHaveBeenCalledTimes(1);
		expect(onHit).toHaveBeenCalledTimes(1);
	});

	// Real (tiny) delays rather than fake timers: lru-cache captures a
	// reference to the real global `performance` object at import time
	// (see its perf.js), before any per-test `vi.useFakeTimers()` call can
	// install a fake one, so advancing fake timers never moves its clock.
	it("ttlForKey overrides ttlMs for matching keys (get/head)", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("repo/refs/heads/main", new Uint8Array([1]));
		await inner.put("repo/objects/aa/bb", new Uint8Array([2]));
		const getSpy = vi.spyOn(inner, "get");
		const cached = createCachedStore(inner, {
			ttlMs: 10_000,
			ttlForKey: (key) => (key.includes("/refs/") ? 20 : undefined),
		});

		await cached.get("repo/refs/heads/main");
		await cached.get("repo/objects/aa/bb");
		expect(getSpy).toHaveBeenCalledTimes(2);

		// Past the short ref ttl but well within the long object ttl.
		await new Promise((r) => setTimeout(r, 50));

		await cached.get("repo/refs/heads/main");
		expect(getSpy).toHaveBeenCalledTimes(3); // ref re-fetched

		await cached.get("repo/objects/aa/bb");
		expect(getSpy).toHaveBeenCalledTimes(3); // object still cached
	});

	it("ttlForKey overrides ttlMs for matching keys (list)", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("repo/refs/heads/main", new Uint8Array([1]));
		const listSpy = vi.spyOn(inner, "list");
		const cached = createCachedStore(inner, {
			cacheLists: true,
			ttlMs: 10_000,
			ttlForKey: (key) => (key.includes("/refs/") ? 20 : undefined),
		});

		await cached.list("repo/refs/heads/");
		await new Promise((r) => setTimeout(r, 50));
		await cached.list("repo/refs/heads/");
		expect(listSpy).toHaveBeenCalledTimes(2);
	});
});

describe("createCachedStore coalescing", () => {
	it("collapses concurrent gets for the same key into one request", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("k", new Uint8Array([1, 2]));
		let resolveGet: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveGet = r;
		});
		const innerGet = inner.get.bind(inner);
		const spy = vi.spyOn(inner, "get").mockImplementation(async (key) => {
			await gate;
			return innerGet(key);
		});
		const cached = createCachedStore(inner);

		const reads = Promise.all([
			cached.get("k"),
			cached.get("k"),
			cached.get("k"),
		]);
		resolveGet?.();
		const results = await reads;
		expect(spy).toHaveBeenCalledTimes(1);
		for (const r of results) expect(r).toEqual(new Uint8Array([1, 2]));
		// Coalesced callers must not share one mutable buffer.
		if (results[0] && results[1]) {
			results[0][0] = 99;
			expect(results[1][0]).toBe(1);
		}
	});

	it("collapses concurrent heads and lists", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("dir/a", new Uint8Array([1]));
		const headSpy = vi.spyOn(inner, "head");
		const listSpy = vi.spyOn(inner, "list");
		const cached = createCachedStore(inner, { cacheLists: true });

		await Promise.all([cached.head("dir/a"), cached.head("dir/a")]);
		expect(headSpy).toHaveBeenCalledTimes(1);

		await Promise.all([
			cached.list("dir/", { limit: 1 }),
			cached.list("dir/", { limit: 1 }),
		]);
		expect(listSpy).toHaveBeenCalledTimes(1);
	});

	it("propagates rejections to all waiters without caching them", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("k", new Uint8Array([3]));
		const innerGet = inner.get.bind(inner);
		const spy = vi.spyOn(inner, "get").mockRejectedValueOnce(new Error("boom"));
		const cached = createCachedStore(inner, { cacheMisses: true });

		const results = await Promise.allSettled([
			cached.get("k"),
			cached.get("k"),
		]);
		expect(results.every((r) => r.status === "rejected")).toBe(true);

		spy.mockImplementation(innerGet);
		expect(await cached.get("k")).toEqual(new Uint8Array([3]));
	});
});

describe("createCachedStore list caching", () => {
	it("does not cache lists by default", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("d/a", new Uint8Array([1]));
		const spy = vi.spyOn(inner, "list");
		const cached = createCachedStore(inner);
		await cached.list("d/");
		await cached.list("d/");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("caches listings and existence probes when enabled", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("d/a", new Uint8Array([1]));
		const spy = vi.spyOn(inner, "list");
		const cached = createCachedStore(inner, { cacheLists: true });

		expect((await cached.list("d/", { delimiter: "/" })).objects).toHaveLength(
			1,
		);
		expect((await cached.list("d/", { delimiter: "/" })).objects).toHaveLength(
			1,
		);
		expect(spy).toHaveBeenCalledTimes(1);

		// A different limit/delimiter is a different cache entry.
		await cached.list("d/", { limit: 1 });
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("preserves non-empty probes across writes underneath them", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("repo/objects/aa/x", new Uint8Array([1]));
		const cached = createCachedStore(inner, { cacheLists: true });

		// Prime a non-empty "directory exists" probe.
		await cached.list("repo/", { limit: 1 });
		const spy = vi.spyOn(inner, "list");

		await cached.put("repo/objects/bb/y", new Uint8Array([2]));
		await cached.list("repo/", { limit: 1 });
		expect(spy).not.toHaveBeenCalled();
	});

	it("clears empty probes and full listings on writes underneath them", async () => {
		const inner = new MemoryObjectStore();
		const cached = createCachedStore(inner, { cacheLists: true });

		// Prime an empty probe (a "missing" marker) and a full listing.
		expect((await cached.list("repo/", { limit: 1 })).objects).toHaveLength(0);
		await inner.put("other/seed", new Uint8Array([0]));
		await cached.list("other/", { delimiter: "/" });

		await cached.put("repo/refs/heads/main", new Uint8Array([1]));
		await cached.put("other/second", new Uint8Array([2]));

		const probe = await cached.list("repo/", { limit: 1 });
		expect(probe.objects).toHaveLength(1);
		const listing = await cached.list("other/", { delimiter: "/" });
		expect(listing.objects).toHaveLength(2);
	});

	it("invalidate clears everything under the prefix, including non-empty probes", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("repo/objects/aa/x", new Uint8Array([1]));
		const cached = createCachedStore(inner, {
			cacheLists: true,
			cacheMisses: true,
		});

		await cached.get("repo/objects/aa/x");
		await cached.get("repo/missing");
		await cached.list("repo/", { limit: 1 });

		// Simulate an external writer replacing the repo contents.
		await inner.delete("repo/objects/aa/x");
		cached.invalidate("repo/");

		expect(await cached.get("repo/objects/aa/x")).toBeNull();
		expect((await cached.list("repo/", { limit: 1 })).objects).toHaveLength(0);
	});

	it("invalidate with an exact key clears listings containing it", async () => {
		const inner = new MemoryObjectStore();
		await inner.put("repo/objects/pack/pack-1.pack", new Uint8Array([1]));
		const cached = createCachedStore(inner, { cacheLists: true });

		await cached.list("repo/objects/pack/", { delimiter: "/" });
		await inner.delete("repo/objects/pack/pack-1.pack");
		cached.invalidate("repo/objects/pack/pack-1.pack");

		const listing = await cached.list("repo/objects/pack/", {
			delimiter: "/",
		});
		expect(listing.objects).toHaveLength(0);
	});
});
