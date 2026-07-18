import { enoent, enotdir, enotempty, eperm } from "./errors.js";
import { toKey } from "./path.js";
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
): GitFsClient {
	const prefix = options.prefix ?? "";
	const key = (filepath: string) => toKey(prefix, filepath);

	async function isDirectory(dirKey: string): Promise<boolean> {
		const { objects, prefixes } = await store.list(`${dirKey}/`, {
			limit: 1,
		});
		return objects.length > 0 || prefixes.length > 0;
	}

	async function stat(filepath: string, syscall: string): Promise<Stat> {
		const k = key(filepath);
		if (k === prefix || k === "") return makeStat("dir", 0);
		const fileStat = await store.head(k);
		if (fileStat) return makeStat("file", fileStat.size);
		if (await isDirectory(k)) return makeStat("dir", 0);
		throw enoent(syscall, filepath);
	}

	return {
		promises: {
			async readFile(filepath, opts) {
				const data = await store.get(key(filepath));
				if (data === null) throw enoent("open", filepath);
				return resolveEncoding(opts) === "utf8"
					? textDecoder.decode(data)
					: data;
			},

			async writeFile(filepath, data, _opts) {
				const bytes =
					typeof data === "string" ? textEncoder.encode(data) : data;
				await store.put(key(filepath), bytes);
			},

			async unlink(filepath) {
				const k = key(filepath);
				if ((await store.head(k)) === null) throw enoent("unlink", filepath);
				await store.delete(k);
			},

			async readdir(dirpath) {
				const k = key(dirpath);
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
				const k = key(dirpath);
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
		},
	};
}
