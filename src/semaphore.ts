/**
 * A FIFO semaphore for bounding in-flight I/O.
 *
 * An unbounded `Promise.all` over a list whose size the caller (or an
 * attacker) controls — a git tree with tens of thousands of blob entries, say,
 * each costing one object-store read — issues that many concurrent requests
 * from a single push or clone. Sockets and memory then scale with the input,
 * and S3-compatible providers rate-limit per account, so one hostile push
 * degrades every other tenant. Bounding the *in-flight* count caps resource
 * use at `limit` no matter how wide the input is, while still letting reads
 * overlap up to that limit instead of running strictly sequentially.
 */
export interface Semaphore {
	run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a FIFO semaphore admitting at most `limit` concurrent `run`
 * executions. Waiters are queued as promises and released in call order — no
 * polling or timers — so a caller blocked on a full semaphore is woken the
 * instant a permit frees, not on the next tick of a poll loop.
 */
export function createSemaphore(limit: number): Semaphore {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(
			`createSemaphore: limit must be an integer >= 1, got ${limit}`,
		);
	}

	let active = 0;
	const waiting: Array<() => void> = [];

	/**
	 * Hand the permit to the next waiter instead of dropping it, so `active`
	 * only decreases when nothing is queued and never exceeds `limit`.
	 */
	function release(): void {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}

	function acquire(): Promise<void> {
		if (active < limit) {
			active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			waiting.push(resolve);
		});
	}

	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			return acquire().then(async () => {
				try {
					return await fn();
				} finally {
					release();
				}
			});
		},
	};
}
