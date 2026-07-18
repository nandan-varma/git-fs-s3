import { LRUCache } from "lru-cache";
import { enoent, enotdir, enotempty, eperm } from "./errors.js";
import { normalizePath } from "./path.js";
import type {
	Encoding,
	GitFsClient,
	GitFsOptions,
	ObjectStore,
	ReadFileOptions,
	Stat,
	WriteFileOptions,
} from "./types.js";

const FILE_MODE = 0o100644;
const DIR_MODE = 0o40000;

/**
 * A loose git object path: `objects/xx/<38 hex>` under any gitdir. The two
 * capture groups let the gitdir scope be recovered from a full path.
 */
const LOOSE_OBJECT_RE = /(^|\/)objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function makeStat(type: "file" | "dir", size: number): Stat {
	const epoch = new Date(0);
	return {
		type,
		mode: type === "file" ? FILE_MODE : DIR_MODE,
		size,
		ino: 0,
		mtimeMs: 0,
		ctimeMs: 0,
		uid: 0,
		gid: 0,
		dev: 0,
		mtime: epoch,
		ctime: epoch,
		isFile: () => type === "file",
		isDirectory: () => type === "dir",
		isSymbolicLink: () => false,
	};
}

function resolveEncoding(
	options?: ReadFileOptions | WriteFileOptions | Encoding,
): Encoding | undefined {
	if (typeof options === "string") return options;
	return options?.encoding;
}

/**
 * The filesystem returned by {@link createGitFs}: the isomorphic-git client
 * plus git-aware maintenance hooks.
 */
export interface GitFs extends GitFsClient {
	/**
	 * Probe, with one bounded list, whether `gitdir` contains any loose
	 * objects, and remember the answer. This is the only way a loose-object
	 * hint is ever created; call it before full-history walks (commit logs,
	 * reachability traversals) so fully packed repositories skip every
	 * guaranteed-miss loose-object read. A later loose write flips the hint
	 * back, so it cannot go stale mid-push.
	 */
	detectLooseObjects(gitdir: string): Promise<void>;
	/**
	 * Warm the cache with every pack file under `gitdir` in parallel (plus
	 * the loose-object hint) before a sequential history walk. Skipped when
	 * the pack directory holds more than `maxPacks * 2` entries — warming
	 * only helps when the cache budget actually fits the packs.
	 */
	prefetchPacks(gitdir: string, options?: { maxPacks?: number }): Promise<void>;
	/**
	 * Clear fs-level state (loose-object hints) under `pathPrefix`, and
	 * forward to the store's `invalidate` when it has one. Call after the
	 * backing store was modified by something other than this fs.
	 */
	invalidate(pathPrefix: string): void;
}

/**
 * Create a promise-based filesystem client for isomorphic-git backed by an
 * {@link ObjectStore}.
 *
 * Semantics:
 * - Directories are implicit, as in object storage: `mkdir` is a no-op and a
 *   directory "exists" whenever at least one key lives under its prefix.
 * - Symbolic links are not supported (`readlink`/`symlink` throw). Bare
 *   repositories never contain them.
 * - Designed for bare, server-side repositories (`git.init({bare: true})`,
 *   plumbing commands, ref updates). Worktree checkouts belong on a real disk.
 */
export function createGitFs(
	store: ObjectStore,
	options: GitFsOptions = {},
): GitFs {
	const prefix = options.prefix ?? "";
	const structurallyAbsent = options.isStructurallyAbsent;
	const useLooseHints = options.looseObjectHints ?? false;
	const onNote = options.onNote;

	const toKey = (path: string): string => {
		if (prefix === "") return path;
		return path === "" ? prefix : `${prefix}/${path}`;
	};

	/**
	 * Per-gitdir "does any loose object exist" hint. Entries are only created
	 * by {@link GitFs.detectLooseObjects}, so a pathological ref that merely
	 * looks like a loose object (`refs/heads/objects/aa/…`) derives a scope
	 * that was never registered and can never be wrongly short-circuited.
	 */
	const looseHints = new LRUCache<string, "none" | "present">({
		max: 1024,
		ttl: options.hintTtlMs ?? 3_600_000,
	});

	/** The gitdir scope of a loose-object path, or null when it isn't one. */
	function looseScope(path: string): string | null {
		const match = LOOSE_OBJECT_RE.exec(path);
		if (match === null) return null;
		return path.slice(0, match.index);
	}

	function knownAbsent(path: string): boolean {
		if (structurallyAbsent?.(path)) return true;
		if (!useLooseHints) return false;
		const scope = looseScope(path);
		return scope !== null && looseHints.get(scope) === "none";
	}

	async function isDirectory(dirKey: string): Promise<boolean> {
		const { objects, prefixes } = await store.list(`${dirKey}/`, {
			limit: 1,
		});
		return objects.length > 0 || prefixes.length > 0;
	}

	async function stat(filepath: string, syscall: string): Promise<Stat> {
		const path = normalizePath(filepath);
		if (knownAbsent(path)) throw enoent(syscall, filepath);
		const k = toKey(path);
		if (k === prefix || k === "") return makeStat("dir", 0);
		const fileStat = await store.head(k);
		if (fileStat) return makeStat("file", fileStat.size);
		// A loose-object path is always a leaf; when the object itself is
		// absent there is no point probing for a directory of the same name.
		if (useLooseHints && looseScope(path) !== null) {
			throw enoent(syscall, filepath);
		}
		if (await isDirectory(k)) return makeStat("dir", 0);
		throw enoent(syscall, filepath);
	}

	const promises: GitFsClient["promises"] = {
		async readFile(filepath, opts) {
			const path = normalizePath(filepath);
			if (knownAbsent(path)) throw enoent("open", filepath);
			const data = await store.get(toKey(path));
			if (data === null) throw enoent("open", filepath);
			return resolveEncoding(opts) === "utf8" ? textDecoder.decode(data) : data;
		},

		async writeFile(filepath, data, _opts) {
			const path = normalizePath(filepath);
			if (useLooseHints) {
				const scope = looseScope(path);
				// Flip before the write lands so a racing read can never
				// short-circuit an object that is in the middle of arriving.
				if (scope !== null) looseHints.set(scope, "present");
			}
			const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
			await store.put(toKey(path), bytes);
		},

		async unlink(filepath) {
			const k = toKey(normalizePath(filepath));
			if ((await store.head(k)) === null) throw enoent("unlink", filepath);
			await store.delete(k);
		},

		async readdir(dirpath) {
			const k = toKey(normalizePath(dirpath));
			const isRoot = k === prefix || k === "";
			const listPrefix = isRoot && k === "" ? "" : `${k}/`;
			const { objects, prefixes } = await store.list(listPrefix, {
				delimiter: "/",
			});
			if (objects.length === 0 && prefixes.length === 0) {
				if (!isRoot && (await store.head(k)) !== null) {
					throw enotdir("scandir", dirpath);
				}
				if (!isRoot) throw enoent("scandir", dirpath);
			}
			const names = objects.map((o) => o.key.slice(listPrefix.length));
			const dirNames = prefixes.map((p) =>
				p.slice(listPrefix.length).replace(/\/$/, ""),
			);
			return [...names, ...dirNames].sort();
		},

		async mkdir(_dirpath, _opts) {
			// Directories are implicit in object storage.
		},

		async rmdir(dirpath) {
			const k = toKey(normalizePath(dirpath));
			const { objects, prefixes } = await store.list(`${k}/`, { limit: 1 });
			if (objects.length > 0 || prefixes.length > 0) {
				throw enotempty("rmdir", dirpath);
			}
			// Empty implicit directories don't exist; nothing to remove.
		},

		stat: (filepath) => stat(filepath, "stat"),
		lstat: (filepath) => stat(filepath, "lstat"),

		async readlink(filepath): Promise<never> {
			throw enoent("readlink", filepath);
		},

		async symlink(_target, filepath): Promise<never> {
			throw eperm("symlink", filepath);
		},

		async chmod(_filepath, _mode) {
			// POSIX modes don't exist in object storage.
		},
	};

	async function detectLooseObjects(gitdir: string): Promise<void> {
		if (!useLooseHints) return;
		const scope = normalizePath(gitdir);
		// A live hint must win over re-detection: after a loose write flips it
		// to "present", re-deriving from a (possibly cached, pre-write) listing
		// could wrongly reinstate "none" and mask real objects.
		if (looseHints.has(scope)) return;
		try {
			const { objects } = await store.list(`${toKey(scope)}/objects/`, {
				limit: 1,
			});
			// Loose fan-out directories (two hex digits) sort before "info/"
			// and "pack/", so when any loose object exists it is the first key.
			const first = objects[0]?.key;
			const hint =
				first !== undefined && LOOSE_OBJECT_RE.test(first)
					? "present"
					: "none";
			looseHints.set(scope, hint);
			onNote?.(`loose objects ${hint} under ${scope}`);
		} catch {
			// Leave unknown — reads fall back to their normal round trip.
		}
	}

	async function prefetchPacks(
		gitdir: string,
		prefetchOptions?: { maxPacks?: number },
	): Promise<void> {
		const maxPacks = prefetchOptions?.maxPacks ?? 30;
		const packDir = `${normalizePath(gitdir)}/objects/pack`;
		const entries = await promises.readdir(packDir).catch(() => []);
		if (entries.length > maxPacks * 2) {
			await detectLooseObjects(gitdir);
			return;
		}
		await Promise.all([
			detectLooseObjects(gitdir),
			...entries.map((name) =>
				promises.readFile(`${packDir}/${name}`).catch(() => undefined),
			),
		]);
	}

	function invalidate(pathPrefix: string): void {
		const normalized = normalizePath(pathPrefix);
		for (const scope of looseHints.keys()) {
			if (scope.startsWith(normalized)) looseHints.delete(scope);
		}
		const maybe = store as ObjectStore & {
			invalidate?: (prefix: string) => void;
		};
		maybe.invalidate?.(toKey(normalized));
	}

	return { promises, detectLooseObjects, prefetchPacks, invalidate };
}
