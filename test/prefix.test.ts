import { describe, expect, it } from "vitest";
import {
	deletePrefix,
	GitConflictError,
	GitRefNotFoundError,
	isNotFoundError,
	isRetryableError,
	MemoryObjectStore,
	movePrefix,
} from "../src/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);

async function seeded(count = 45) {
	const store = new MemoryObjectStore();
	for (let i = 0; i < count; i++) await store.put(`a/${i}`, bytes(`${i}`));
	await store.put("ab/keep", bytes("k"));
	return store;
}

describe("deletePrefix", () => {
	it("deletes everything under the prefix and nothing else", async () => {
		const store = await seeded();
		expect(await deletePrefix(store, "a/")).toBe(45);
		expect((await store.list("a/")).objects).toEqual([]);
		expect(await store.get("ab/keep")).not.toBeNull();
	});
});

describe("movePrefix", () => {
	it("moves keys to the new prefix, preserving relative paths", async () => {
		const store = await seeded(3);
		expect(await movePrefix(store, "a/", "b/")).toBe(3);
		expect((await store.list("a/")).objects).toEqual([]);
		expect(await store.get("b/2")).toEqual(bytes("2"));
		expect(await store.get("ab/keep")).not.toBeNull();
	});

	it("uses a custom copy and leaves the source untouched when one fails", async () => {
		const store = await seeded(3);
		await expect(
			movePrefix(store, "a/", "b/", {
				copy: async (from) => {
					if (from === "a/1") throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
		expect((await store.list("a/")).objects).toHaveLength(3);
	});

	it("rejects overlapping prefixes", async () => {
		const store = await seeded(1);
		await expect(movePrefix(store, "a/", "a/b/")).rejects.toThrow("overlap");
	});
});

describe("isNotFoundError", () => {
	it("is true for not-found git errors only", () => {
		expect(isNotFoundError(new GitRefNotFoundError("r"))).toBe(true);
		expect(isNotFoundError(new GitConflictError("c"))).toBe(false);
		expect(isNotFoundError(null)).toBe(false);
	});
});

describe("isRetryableError", () => {
	it("retries fetch failures, timeouts and 5xx/429 only", () => {
		expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
		const timeout = new Error("t");
		timeout.name = "TimeoutError";
		expect(isRetryableError(timeout)).toBe(true);
		expect(isRetryableError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
		expect(isRetryableError({ $metadata: { httpStatusCode: 403 } })).toBe(
			false,
		);
		expect(isRetryableError(new Error("x"))).toBe(false);
		expect(isRetryableError("x")).toBe(false);
	});
});
