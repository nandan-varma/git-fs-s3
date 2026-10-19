/**
 * A `fetch` that speaks just enough of the S3 REST API (path-style
 * GetObject/PutObject/DeleteObject/HeadObject/CopyObject/ListObjectsV2) over
 * an in-memory Map — so tests can drive the fetch store's real request signing,
 * XML parsing and pagination without a network. Every request must carry a
 * SigV4 Authorization header, as R2 requires.
 */

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function createFakeS3(options: { bucket: string; pageSize?: number }) {
	const objects = new Map<string, Uint8Array>();
	const requests: { method: string; key: string; query: string }[] = [];
	const pageSize = options.pageSize ?? 1000;

	function listPage(params: URLSearchParams): string {
		const prefix = params.get("prefix") ?? "";
		const delimiter = params.get("delimiter");
		const maxKeys = Math.min(
			Number(params.get("max-keys") ?? pageSize),
			pageSize,
		);
		const start = Number(params.get("continuation-token") ?? 0);
		const entries: string[] = [];
		const seenPrefixes = new Set<string>();
		const sorted = [...objects.keys()]
			.filter((key) => key.startsWith(prefix))
			.sort();
		let index = start;
		for (; index < sorted.length && entries.length < maxKeys; index++) {
			const key = sorted[index] as string;
			const rest = key.slice(prefix.length);
			const cut = delimiter ? rest.indexOf(delimiter) : -1;
			if (cut !== -1) {
				const common = prefix + rest.slice(0, cut + 1);
				if (!seenPrefixes.has(common)) {
					seenPrefixes.add(common);
					entries.push(
						`<CommonPrefixes><Prefix>${escapeXml(common)}</Prefix></CommonPrefixes>`,
					);
				}
			} else {
				entries.push(
					`<Contents><Key>${escapeXml(key)}</Key><Size>${objects.get(key)?.byteLength ?? 0}</Size></Contents>`,
				);
			}
		}
		const truncated = index < sorted.length;
		return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${entries.join("")}${truncated ? `<NextContinuationToken>${index}</NextContinuationToken>` : ""}</ListBucketResult>`;
	}

	const fetchImpl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(input, init);
		if (!request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) {
			return new Response("unsigned", { status: 403 });
		}
		const url = new URL(request.url);
		const bucketPrefix = `/${options.bucket}`;
		if (!url.pathname.startsWith(bucketPrefix)) {
			return new Response("NoSuchBucket", { status: 404 });
		}
		const key = decodeURIComponent(url.pathname.slice(bucketPrefix.length + 1));
		requests.push({ method: request.method, key, query: url.search });

		if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
			return new Response(listPage(url.searchParams), {
				headers: { "Content-Type": "application/xml" },
			});
		}
		switch (request.method) {
			case "GET": {
				const data = objects.get(key);
				return data
					? new Response(data as Uint8Array<ArrayBuffer>)
					: new Response("<Error><Code>NoSuchKey</Code></Error>", {
							status: 404,
						});
			}
			case "HEAD": {
				const data = objects.get(key);
				return data
					? new Response(null, {
							headers: { "Content-Length": String(data.byteLength) },
						})
					: new Response(null, { status: 404 });
			}
			case "PUT": {
				const source = request.headers.get("x-amz-copy-source");
				if (source) {
					const sourceKey = decodeURIComponent(
						source.slice(bucketPrefix.length + 1),
					);
					const data = objects.get(sourceKey);
					if (!data) {
						return new Response("<Error><Code>NoSuchKey</Code></Error>", {
							status: 404,
						});
					}
					objects.set(key, data.slice());
					return new Response("<CopyObjectResult></CopyObjectResult>");
				}
				objects.set(key, new Uint8Array(await request.arrayBuffer()));
				return new Response(null, { status: 200 });
			}
			case "DELETE":
				objects.delete(key);
				return new Response(null, { status: 204 });
			default:
				return new Response("MethodNotAllowed", { status: 405 });
		}
	};

	return { objects, requests, fetch: fetchImpl as typeof fetch };
}
