/**
 * The fetch-based S3 store against a fake S3 endpoint
 * (helpers/fake-s3-fetch.ts): signing, 404 → null mapping, error statuses,
 * ListObjectsV2 XML parsing with delimiters and pagination, and server-side
 * copy.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createFetchS3Store,
	parseListObjectsV2,
	S3HttpError,
} from "../src/stores/fetch-s3.js";
import { createFakeS3 } from "./helpers/fake-s3-fetch.js";

const bytes = (text: string) => new TextEncoder().encode(text);

function makeStore(pageSize?: number) {
	const s3 = createFakeS3({ bucket: "bucket", pageSize });
	const store = createFetchS3Store({
		endpoint: "https://account.r2.cloudflarestorage.com",
		bucket: "bucket",
		accessKeyId: "key",
		secretAccessKey: "secret",
		contentType: (key) => (key.endsWith("HEAD") ? "text/plain" : undefined),
		fetch: s3.fetch,
	});
	return { s3, store };
}

describe("createFetchS3Store", () => {
	it("round-trips objects and maps a missing key to null", async () => {
		const { store } = makeStore();
		await store.put("repos/a/b/git/HEAD", bytes("ref: refs/heads/main\n"));

		expect(
			new TextDecoder().decode(
				(await store.get("repos/a/b/git/HEAD")) ?? new Uint8Array(),
			),
		).toBe("ref: refs/heads/main\n");
		expect(await store.get("repos/a/b/git/missing")).toBeNull();
		expect(await store.head("repos/a/b/git/HEAD")).toEqual({ size: 21 });
		expect(await store.head("repos/a/b/git/missing")).toBeNull();
	});

	it("deletes, tolerating a key that's already gone", async () => {
		const { store } = makeStore();
		await store.put("k", bytes("v"));
		await store.delete("k");
		await store.delete("k");
		expect(await store.get("k")).toBeNull();
	});

	it("encodes key segments in the URL but keeps the slashes", async () => {
		const { s3, store } = makeStore();
		await store.put("repos/o/r/git/refs/heads/a b+c", bytes("x"));
		expect(s3.objects.has("repos/o/r/git/refs/heads/a b+c")).toBe(true);
	});

	it("lists direct children and common prefixes with a delimiter", async () => {
		const { store } = makeStore();
		for (const key of [
			"g/objects/pack/a.idx",
			"g/objects/pack/a.pack",
			"g/objects/ab/cdef",
			"g/HEAD",
		]) {
			await store.put(key, bytes(key));
		}

		const result = await store.list("g/objects/", { delimiter: "/" });
		expect(result.objects).toEqual([]);
		expect(result.prefixes.sort()).toEqual([
			"g/objects/ab/",
			"g/objects/pack/",
		]);

		const flat = await store.list("g/");
		expect(flat.objects.map((o) => o.key).sort()).toEqual([
			"g/HEAD",
			"g/objects/ab/cdef",
			"g/objects/pack/a.idx",
			"g/objects/pack/a.pack",
		]);
		expect(flat.objects.find((o) => o.key === "g/HEAD")?.size).toBe(6);
	});

	it("follows continuation tokens across pages", async () => {
		const { s3, store } = makeStore(2);
		for (let i = 0; i < 5; i++) await store.put(`p/${i}`, bytes(String(i)));

		const { objects } = await store.list("p/");
		expect(objects.map((o) => o.key)).toEqual([
			"p/0",
			"p/1",
			"p/2",
			"p/3",
			"p/4",
		]);
		expect(
			s3.requests.filter((r) => r.query.includes("list-type")),
		).toHaveLength(3);
	});

	it("stops paging once `limit` entries are found", async () => {
		const { s3, store } = makeStore(2);
		for (let i = 0; i < 5; i++) await store.put(`p/${i}`, bytes(String(i)));

		const { objects } = await store.list("p/", { limit: 1 });
		expect(objects).toHaveLength(1);
		expect(
			s3.requests.filter((r) => r.query.includes("list-type")),
		).toHaveLength(1);
	});

	it("copies server-side", async () => {
		const { s3, store } = makeStore();
		await store.put("old/HEAD", bytes("h"));
		await store.copy("old/HEAD", "new/HEAD");
		expect(new TextDecoder().decode(s3.objects.get("new/HEAD"))).toBe("h");
		expect(s3.objects.has("old/HEAD")).toBe(true);
	});

	it("throws S3HttpError with the status for failures, in the shape the retry policy reads", async () => {
		const store = createFetchS3Store({
			endpoint: "https://account.r2.cloudflarestorage.com",
			bucket: "bucket",
			accessKeyId: "key",
			secretAccessKey: "secret",
			fetch: vi.fn(async () => new Response("boom", { status: 503 })),
		});
		const error = await store.get("k").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(S3HttpError);
		expect((error as S3HttpError).$metadata.httpStatusCode).toBe(503);

		const throttled = createFetchS3Store({
			endpoint: "https://account.r2.cloudflarestorage.com",
			bucket: "bucket",
			accessKeyId: "key",
			secretAccessKey: "secret",
			fetch: vi.fn(async () => new Response("slow", { status: 429 })),
		});
		await expect(throttled.put("k", bytes("v"))).rejects.toMatchObject({
			name: "SlowDown",
		});
	});

	it("rejects a copy that answers 200 with an <Error> body", async () => {
		const store = createFetchS3Store({
			endpoint: "https://account.r2.cloudflarestorage.com",
			bucket: "bucket",
			accessKeyId: "key",
			secretAccessKey: "secret",
			fetch: vi.fn(
				async () =>
					new Response("<Error><Code>InternalError</Code></Error>", {
						status: 200,
					}),
			),
		});
		await expect(store.copy("a", "b")).rejects.toBeInstanceOf(S3HttpError);
	});
});

describe("parseListObjectsV2", () => {
	it("decodes XML entities in keys", () => {
		const page = parseListObjectsV2(
			"<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a&amp;b&lt;c&#39;</Key><Size>3</Size></Contents></ListBucketResult>",
		);
		expect(page.objects).toEqual([{ key: "a&b<c'", size: 3 }]);
		expect(page.nextToken).toBeUndefined();
	});

	it("only returns a token when the listing is truncated", () => {
		const page = parseListObjectsV2(
			"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>",
		);
		expect(page.nextToken).toBe("t1");
	});
});
