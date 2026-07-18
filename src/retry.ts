import type { ObjectStore } from "./types.js";

/** Options accepted by {@link createRetryStore}. */
export interface RetryOptions {
	/** Retries after the first attempt (total attempts = retries + 1). Default 3. */
	retries?: number;
	/** Backoff base delay in milliseconds, doubled each attempt. Default 100. */
	initialDelayMs?: number;
	/** Upper bound for the backoff base delay. Default 5000. */
	maxDelayMs?: number;
	/** Random jitter added to each delay, as a fraction of it. Default 0.3. */
	jitter?: number;
	/**
	 * Decide whether an error is worth retrying. The store contract maps
	 * "not found" to `null` rather than throwing, so any thrown error is a
	 * genuine failure; the default retries network faults, throttling, and
	 * HTTP 5xx responses.
	 */
	isRetryable?: (error: unknown) => boolean;
	/**
	 * Circuit breaker configuration, or `false` to disable. After `threshold`
	 * consecutive failures the store fails fast for `resetMs`, then lets one
	 * request probe the backend again. Defaults: 5 failures, 30 000 ms.
	 */
	breaker?: false | { threshold?: number; resetMs?: number };
	/** Called before each retry sleep; useful for logging/metrics. */
	onRetry?: (info: {
		key: string;
		op: string;
		attempt: number;
		delayMs: number;
	}) => void;
}

/**
 * Thrown instead of calling the backend while the circuit breaker is open.
 * Carries `code: "EUNAVAILABLE"` so callers can map it to a 503.
 */
export class CircuitOpenError extends Error {
	readonly code = "EUNAVAILABLE";

	constructor() {
		super("Circuit breaker is open, object store unavailable");
		this.name = "CircuitOpenError";
	}
}

const RETRYABLE_NAMES = new Set([
	"TimeoutError",
	"RequestTimeout",
	"RequestTimeoutException",
	"SlowDown",
	"ThrottlingException",
	"TooManyRequestsException",
]);

const RETRYABLE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPROTO",
]);

function defaultIsRetryable(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const err = error as {
		name?: string;
		code?: string;
		$metadata?: { httpStatusCode?: number };
	};
	if (err.name !== undefined && RETRYABLE_NAMES.has(err.name)) return true;
	if (err.code !== undefined && RETRYABLE_CODES.has(err.code)) return true;
	const status = err.$metadata?.httpStatusCode;
	return status !== undefined && (status >= 500 || status === 429);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap an {@link ObjectStore} with retries (exponential backoff + jitter) and
 * an optional per-instance circuit breaker.
 *
 * Place this decorator closest to the network store, underneath any cache:
 * the cache then never stores transient failures, and callers coalesced onto
 * one request share a single retried attempt.
 */
export function createRetryStore(
	store: ObjectStore,
	options: RetryOptions = {},
): ObjectStore {
	const retries = options.retries ?? 3;
	const initialDelayMs = options.initialDelayMs ?? 100;
	const maxDelayMs = options.maxDelayMs ?? 5000;
	const jitter = options.jitter ?? 0.3;
	const isRetryable = options.isRetryable ?? defaultIsRetryable;
	const breaker =
		options.breaker === false
			? null
			: {
					threshold: options.breaker?.threshold ?? 5,
					resetMs: options.breaker?.resetMs ?? 30_000,
				};

	let failures = 0;
	let lastFailureAt = 0;
	let state: "closed" | "open" | "half-open" = "closed";

	async function guarded<T>(fn: () => Promise<T>): Promise<T> {
		if (breaker === null) return fn();
		if (state === "open") {
			if (Date.now() - lastFailureAt < breaker.resetMs) {
				throw new CircuitOpenError();
			}
			state = "half-open";
		}
		try {
			const result = await fn();
			if (state === "half-open") {
				state = "closed";
				failures = 0;
			}
			return result;
		} catch (error) {
			failures++;
			lastFailureAt = Date.now();
			if (failures >= breaker.threshold) state = "open";
			throw error;
		}
	}

	async function run<T>(op: string, key: string, fn: () => Promise<T>) {
		let lastError: unknown;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await guarded(fn);
			} catch (error) {
				lastError = error;
				if (error instanceof CircuitOpenError) throw error;
				if (!isRetryable(error) || attempt === retries) throw error;
				const base = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
				const delayMs = Math.round(base + Math.random() * base * jitter);
				options.onRetry?.({ key, op, attempt: attempt + 1, delayMs });
				await sleep(delayMs);
			}
		}
		throw lastError;
	}

	return {
		get: (key) => run("get", key, () => store.get(key)),
		put: (key, data) => run("put", key, () => store.put(key, data)),
		delete: (key) => run("delete", key, () => store.delete(key)),
		head: (key) => run("head", key, () => store.head(key)),
		list: (prefix, listOptions) =>
			run("list", prefix, () => store.list(prefix, listOptions)),
	};
}
