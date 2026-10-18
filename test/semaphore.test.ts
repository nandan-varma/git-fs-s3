import { describe, expect, it } from "vitest";
import { createSemaphore } from "../src/semaphore.js";

/** A promise plus the handles to settle it, so a test can hold a task in
 * flight and observe which other tasks the semaphore admits meanwhile. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let queued microtasks run, so tasks blocked on a deferred can start. */
const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

describe("createSemaphore", () => {
	it("never admits more than `limit` concurrent runs", async () => {
		const sem = createSemaphore(3);
		const gates = Array.from({ length: 10 }, () => deferred());
		let active = 0;
		let maxActive = 0;
		const starts: number[] = [];

		const runs = gates.map((gate, index) =>
			sem.run(async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				starts.push(index);
				await gate.promise;
				active--;
				return index;
			}),
		);

		await tick();
		expect(starts).toEqual([0, 1, 2]);

		// Drain one at a time: each completion must admit exactly one waiter.
		for (const gate of gates) {
			gate.resolve();
			await tick();
			expect(maxActive).toBeLessThanOrEqual(3);
		}

		expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(maxActive).toBe(3);
	});

	it("starts queued runs in FIFO order", async () => {
		const sem = createSemaphore(1);
		const first = deferred();
		const starts: string[] = [];

		const runs = [
			sem.run(async () => {
				starts.push("held");
				await first.promise;
			}),
			sem.run(async () => {
				starts.push("second");
			}),
			sem.run(async () => {
				starts.push("third");
			}),
		];

		await tick();
		expect(starts).toEqual(["held"]);

		first.resolve();
		await Promise.all(runs);
		expect(starts).toEqual(["held", "second", "third"]);
	});

	it("resolves with the run's value and propagates its rejection", async () => {
		const sem = createSemaphore(2);
		await expect(sem.run(async () => 42)).resolves.toBe(42);

		const boom = new Error("boom");
		await expect(
			sem.run(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);

		// A rejected run must release its permit just like a resolved one.
		const gate = deferred();
		const blocked = sem.run(() => gate.promise);
		await expect(sem.run(async () => "still admitted")).resolves.toBe(
			"still admitted",
		);
		gate.resolve();
		await blocked;
	});

	it("rejects a limit that isn't an integer >= 1", () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createSemaphore(limit)).toThrow(/integer >= 1/);
		}
		expect(() => createSemaphore(1)).not.toThrow();
	});
});
