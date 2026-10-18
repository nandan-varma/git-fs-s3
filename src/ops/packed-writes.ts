/**
 * Packed writes: run git plumbing (writeBlob/writeTree/writeCommit, and
 * anything built on them) against a repository, but store the objects it
 * creates as one pack instead of one loose object each.
 *
 * Why it matters on object storage: one PUT per object becomes two per
 * operation (pack + index), and a repository that is never given loose
 * objects stays "fully packed" forever — which is what makes the loose-object
 * hint (`GitFs.detectLooseObjects`) safe across processes. A process that
 * once saw "no loose objects" in a gitdir can't be told when another process
 * writes one; if nothing ever writes loose objects, that answer stays true.
 *
 * Ordering is preserved: the pending objects are flushed (pack, then its
 * index) before any other file is written — so a ref written inside `fn`
 * never becomes visible before the objects it names.
 */
import { inflate } from "../edge-utils.js";
import { parseLooseObjectPath } from "../git-layout.js";
import {
	encodePack,
	type PackObject,
	type PackObjectType,
	storePack,
} from "../pack-write.js";
import type { IsoGitFs, Repo } from "./types.js";

interface PromiseFs {
	readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
	writeFile(
		path: string,
		data: Uint8Array | string,
		options?: unknown,
	): Promise<void>;
	stat(path: string): Promise<unknown>;
	lstat(path: string): Promise<unknown>;
	[key: string]: unknown;
}

const OBJECT_TYPES = new Set<PackObjectType>(["commit", "tree", "blob", "tag"]);

/** Split a loose object's inflated bytes ("<type> <size>\0<content>"). */
function parseLooseObject(raw: Uint8Array<ArrayBuffer>): PackObject {
	const nul = raw.indexOf(0);
	const header = new TextDecoder().decode(raw.subarray(0, nul));
	const [type, size] = header.split(" ");
	const content = raw.slice(nul + 1);
	if (
		!OBJECT_TYPES.has(type as PackObjectType) ||
		Number(size) !== content.length
	) {
		throw new Error(`packed writes: malformed object header "${header}"`);
	}
	return { type: type as PackObjectType, content };
}

function fileStat(size: number) {
	const epoch = new Date(0);
	return {
		type: "file",
		mode: 0o100644,
		size,
		ino: 0,
		mtimeMs: 0,
		ctimeMs: 0,
		uid: 0,
		gid: 0,
		dev: 0,
		mtime: epoch,
		ctime: epoch,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	};
}

/**
 * Run `fn` with a repo whose new objects are buffered and stored as a single
 * pack. Objects are flushed before any non-object write inside `fn`, and once
 * more when `fn` resolves; if `fn` throws, still-unflushed objects are
 * discarded (they'd be unreachable anyway). Serialize concurrent writers to
 * the same repository externally, as for any write.
 */
export async function withPackedWrites<T>(
	repo: Repo,
	fn: (packedRepo: Repo) => Promise<T>,
): Promise<T> {
	const base = (repo.fs as unknown as { promises: PromiseFs }).promises;
	const pending = new Map<string, Uint8Array<ArrayBuffer>>(); // path → deflated loose bytes

	async function flush(): Promise<void> {
		if (pending.size === 0) return;
		const objects = await Promise.all(
			[...pending.values()].map(async (deflated) =>
				parseLooseObject(await inflate(deflated)),
			),
		);
		await storePack(repo, await encodePack(objects));
		pending.clear();
	}

	const promises: PromiseFs = new Proxy(base, {
		get(target, property, receiver) {
			switch (property) {
				case "writeFile":
					return async (
						path: string,
						data: Uint8Array | string,
						options?: unknown,
					) => {
						if (
							parseLooseObjectPath(path) !== null &&
							typeof data !== "string"
						) {
							pending.set(path, new Uint8Array(data));
							return;
						}
						await flush();
						return target.writeFile(path, data, options);
					};
				case "readFile":
					return async (path: string, options?: unknown) => {
						const data = pending.get(path);
						if (data === undefined) return target.readFile(path, options);
						return data;
					};
				case "stat":
				case "lstat":
					return async (path: string) => {
						const data = pending.get(path);
						if (data !== undefined) return fileStat(data.length);
						return target[property](path);
					};
				default: {
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}
			}
		},
	});

	const packedRepo: Repo = { ...repo, fs: { promises } as unknown as IsoGitFs };
	const result = await fn(packedRepo);
	await flush();
	return result;
}
