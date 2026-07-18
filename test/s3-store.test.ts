import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../src/stores/s3.js";

/**
 * The S3 store is exercised against a stub client that replays realistic
 * ListObjectsV2/GetObject/HeadObject responses — the AWS SDK's own wire
 * handling is not under test here.
 */
type CommandInput = {
	constructor: { name: string };
	input: Record<string, unknown>;
};

function stubClient(
	handler: (name: string, input: Record<string, unknown>) => unknown,
): S3Client {
	return {
		send: async (command: CommandInput) =>
			handler(command.constructor.name, command.input),
	} as unknown as S3Client;
}

function notFound(name: string): never {
	const error = new Error(name) as Error & {
		name: string;
		$metadata: { httpStatusCode: number };
	};
	error.name = name;
	error.$metadata = { httpStatusCode: 404 };
	throw error;
}

describe("S3ObjectStore", () => {
	it("prefixes keys and strips the prefix from list results", async () => {
		const seen: Record<string, unknown>[] = [];
		const store = new S3ObjectStore({
			client: stubClient((name, input) => {
				seen.push(input);
				if (name === "ListObjectsV2Command") {
					return {
						Contents: [{ Key: "git/repo/HEAD", Size: 20 }],
						CommonPrefixes: [{ Prefix: "git/repo/refs/" }],
					};
				}
				return {};
			}),
			bucket: "bucket",
			prefix: "git/",
		});

		const result = await store.list("repo/", { delimiter: "/" });
		expect(seen[0]?.Prefix).toBe("git/repo/");
		expect(result.objects).toEqual([{ key: "repo/HEAD", size: 20 }]);
		expect(result.prefixes).toEqual(["repo/refs/"]);
	});

	it("returns null on 404s from get and head", async () => {
		const store = new S3ObjectStore({
			client: stubClient((name) =>
				name === "GetObjectCommand"
					? notFound("NoSuchKey")
					: notFound("NotFound"),
			),
			bucket: "bucket",
		});
		expect(await store.get("missing")).toBeNull();
		expect(await store.head("missing")).toBeNull();
	});

	it("rethrows non-404 errors", async () => {
		const store = new S3ObjectStore({
			client: stubClient(() => {
				throw new Error("AccessDenied");
			}),
			bucket: "bucket",
		});
		await expect(store.get("k")).rejects.toThrow("AccessDenied");
	});

	it("paginates list results", async () => {
		let call = 0;
		const store = new S3ObjectStore({
			client: stubClient(() => {
				call++;
				return call === 1
					? {
							Contents: [{ Key: "a", Size: 1 }],
							NextContinuationToken: "next",
						}
					: { Contents: [{ Key: "b", Size: 2 }] };
			}),
			bucket: "bucket",
		});
		const result = await store.list("");
		expect(result.objects.map((o) => o.key)).toEqual(["a", "b"]);
		expect(call).toBe(2);
	});

	it("stops early when a limit is given", async () => {
		let call = 0;
		const store = new S3ObjectStore({
			client: stubClient(() => {
				call++;
				return {
					Contents: [{ Key: `k${call}`, Size: 1 }],
					NextContinuationToken: "more",
				};
			}),
			bucket: "bucket",
		});
		const result = await store.list("", { limit: 1 });
		expect(result.objects).toHaveLength(1);
		expect(call).toBe(1);
	});
});
