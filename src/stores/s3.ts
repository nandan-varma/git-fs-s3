import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import type {
	ListOptions,
	ListResult,
	ObjectStat,
	ObjectStore,
} from "../types.js";

export interface S3ObjectStoreOptions {
	/** A configured S3Client. Works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, … */
	client: S3Client;
	bucket: string;
	/** Key prefix for every object, e.g. `"git"`. Optional. */
	prefix?: string;
	/**
	 * Derive a Content-Type header for uploads from the (un-prefixed) key.
	 * Return `undefined` to let S3 apply its default. Cosmetic — git never
	 * reads it back — but keeps refs and config human-readable in bucket UIs.
	 */
	contentType?: (key: string) => string | undefined;
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const err = error as {
		name?: string;
		$metadata?: { httpStatusCode?: number };
	};
	return (
		err.name === "NoSuchKey" ||
		err.name === "NotFound" ||
		err.$metadata?.httpStatusCode === 404
	);
}

/**
 * {@link ObjectStore} over any S3-compatible API via `@aws-sdk/client-s3`
 * (peer dependency). One instance per bucket/prefix; reuse a single
 * `S3Client` across stores so HTTP connections are pooled.
 */
export class S3ObjectStore implements ObjectStore {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly prefix: string;
	private readonly contentType?: (key: string) => string | undefined;

	constructor(options: S3ObjectStoreOptions) {
		this.client = options.client;
		this.bucket = options.bucket;
		this.contentType = options.contentType;
		this.prefix = options.prefix
			? options.prefix.replace(/\/+$/, "").concat("/")
			: "";
	}

	private fullKey(key: string): string {
		return this.prefix + key;
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
			);
			if (!response.Body) return new Uint8Array(0);
			return await response.Body.transformToByteArray();
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: this.fullKey(key),
				Body: data,
				ContentType: this.contentType?.(key),
			}),
		);
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
		);
	}

	async head(key: string): Promise<ObjectStat | null> {
		try {
			const response = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
			);
			return { size: response.ContentLength ?? 0 };
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async list(prefix: string, options?: ListOptions): Promise<ListResult> {
		const fullPrefix = this.fullKey(prefix);
		const limit = options?.limit;
		const objects: ListResult["objects"] = [];
		const prefixes = new Set<string>();
		let continuationToken: string | undefined;

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: fullPrefix,
					Delimiter: options?.delimiter,
					ContinuationToken: continuationToken,
					MaxKeys: limit !== undefined ? Math.min(limit, 1000) : undefined,
				}),
			);
			for (const item of response.Contents ?? []) {
				if (item.Key === undefined) continue;
				objects.push({
					key: item.Key.slice(this.prefix.length),
					size: item.Size ?? 0,
				});
			}
			for (const p of response.CommonPrefixes ?? []) {
				if (p.Prefix === undefined) continue;
				prefixes.add(p.Prefix.slice(this.prefix.length));
			}
			if (limit !== undefined && objects.length + prefixes.size >= limit) {
				break;
			}
			continuationToken = response.NextContinuationToken;
		} while (continuationToken);

		return { objects, prefixes: [...prefixes] };
	}
}
