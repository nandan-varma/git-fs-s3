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
});
