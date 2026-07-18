import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "../src/index.js";
import {
	CircuitOpenError,
	createRetryStore,
	MemoryObjectStore,
} from "../src/index.js";

function transientError(): Error {
	const err = new Error("socket hang up") as Error & { code: string };
	err.code = "ECONNRESET";
	return err;
}

function fatalError(): Error {
	const err = new Error("access denied") as Error & {
		$metadata: { httpStatusCode: number };
	};
	err.$metadata = { httpStatusCode: 403 };
	return err;
}

/** A store whose `get` fails `failures` times before succeeding. */
function flakyStore(failures: number, error: () => Error = transientError) {
	const inner = new MemoryObjectStore();
	let remaining = failures;
	let calls = 0;
	const store: ObjectStore = {
		get: async (key) => {
			calls++;
			if (remaining > 0) {
				remaining--;
				throw error();
			}
			return inner.get(key);
		},
		put: (key, data) => inner.put(key, data),
		delete: (key) => inner.delete(key),
		head: (key) => inner.head(key),
		list: (prefix, options) => inner.list(prefix, options),
	};
	return { store, inner, callCount: () => calls };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createRetryStore", () => {
	it("retries transient errors with backoff and succeeds", async () => {
		vi.useFakeTimers();
		const { store, inner, callCount } = flakyStore(2);
		await inner.put("k", new Uint8Array([7]));
		const retried = createRetryStore(store, { retries: 3 });

		const pending = retried.get("k");
		await vi.runAllTimersAsync();
		expect(await pending).toEqual(new Uint8Array([7]));
		expect(callCount()).toBe(3);
	});

	it("gives up after the configured number of retries", async () => {
		vi.useFakeTimers();
		const { store, callCount } = flakyStore(Number.POSITIVE_INFINITY);
		const retried = createRetryStore(store, { retries: 2, breaker: false });

		const pending = retried.get("k").catch((e) => e);
		await vi.runAllTimersAsync();
		expect(await pending).toBeInstanceOf(Error);
		expect(callCount()).toBe(3);
	});

	it("does not retry non-retryable errors", async () => {
		const { store, callCount } = flakyStore(
			Number.POSITIVE_INFINITY,
			fatalError,
		);
		const retried = createRetryStore(store);

		await expect(retried.get("k")).rejects.toThrow("access denied");
		expect(callCount()).toBe(1);
	});

	it("honours a custom isRetryable", async () => {
		vi.useFakeTimers();
		const { store, inner, callCount } = flakyStore(1, fatalError);
		await inner.put("k", new Uint8Array([1]));
		const retried = createRetryStore(store, { isRetryable: () => true });

		const pending = retried.get("k");
		await vi.runAllTimersAsync();
		expect(await pending).toEqual(new Uint8Array([1]));
		expect(callCount()).toBe(2);
	});

	it("reports each retry through onRetry", async () => {
		vi.useFakeTimers();
		const { store, inner } = flakyStore(2);
		await inner.put("k", new Uint8Array([1]));
		const onRetry = vi.fn();
		const retried = createRetryStore(store, { onRetry });

		const pending = retried.get("k");
		await vi.runAllTimersAsync();
		await pending;
		expect(onRetry).toHaveBeenCalledTimes(2);
		expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
			key: "k",
			op: "get",
			attempt: 1,
		});
	});

	it("opens the circuit after the failure threshold and fails fast", async () => {
		vi.useFakeTimers();
		const { store, callCount } = flakyStore(Number.POSITIVE_INFINITY);
		const retried = createRetryStore(store, {
			retries: 0,
			breaker: { threshold: 3, resetMs: 30_000 },
		});

		for (let i = 0; i < 3; i++) {
			await expect(retried.get("k")).rejects.toThrow("socket hang up");
		}
		const callsWhenOpened = callCount();
		await expect(retried.get("k")).rejects.toBeInstanceOf(CircuitOpenError);
		expect(callCount()).toBe(callsWhenOpened);
	});

	it("half-opens after resetMs and closes again on success", async () => {
		vi.useFakeTimers();
		const { store, inner, callCount } = flakyStore(3);
		await inner.put("k", new Uint8Array([5]));
		const retried = createRetryStore(store, {
			retries: 0,
			breaker: { threshold: 3, resetMs: 30_000 },
		});

		for (let i = 0; i < 3; i++) {
			await expect(retried.get("k")).rejects.toThrow();
		}
		await expect(retried.get("k")).rejects.toBeInstanceOf(CircuitOpenError);

		vi.advanceTimersByTime(30_001);
		expect(await retried.get("k")).toEqual(new Uint8Array([5]));
		// Closed again: further requests reach the backend normally.
		expect(await retried.get("k")).toEqual(new Uint8Array([5]));
		expect(callCount()).toBe(5);
	});

	it("keeps breaker state per instance", async () => {
		vi.useFakeTimers();
		const broken = flakyStore(Number.POSITIVE_INFINITY);
		const healthy = flakyStore(0);
		await healthy.inner.put("k", new Uint8Array([9]));
		const brokenStore = createRetryStore(broken.store, {
			retries: 0,
			breaker: { threshold: 1, resetMs: 30_000 },
		});
		const healthyStore = createRetryStore(healthy.store, {
			retries: 0,
			breaker: { threshold: 1, resetMs: 30_000 },
		});

		await expect(brokenStore.get("k")).rejects.toThrow();
		await expect(brokenStore.get("k")).rejects.toBeInstanceOf(CircuitOpenError);
		expect(await healthyStore.get("k")).toEqual(new Uint8Array([9]));
	});

	it("passes through put/delete/head/list", async () => {
		const inner = new MemoryObjectStore();
		const retried = createRetryStore(inner);
		await retried.put("a/b", new Uint8Array([1, 2]));
		expect(await retried.head("a/b")).toEqual({ size: 2 });
		expect((await retried.list("a/")).objects).toHaveLength(1);
		await retried.delete("a/b");
		expect(await retried.head("a/b")).toBeNull();
	});
});
