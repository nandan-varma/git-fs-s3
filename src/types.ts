/**
 * Minimal key/value object-storage contract the git filesystem is built on.
 *
 * Implement this interface to back git with any storage system. Two
 * implementations ship with the package: {@link ../stores/memory.MemoryObjectStore}
 * and {@link ../stores/s3.S3ObjectStore}.
 */
export interface ObjectStore {
	/** Return the object's bytes, or `null` if the key does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	/** Create or overwrite the object at `key`. */
	put(key: string, data: Uint8Array): Promise<void>;
	/** Delete the object at `key`. Must succeed silently if it does not exist. */
	delete(key: string): Promise<void>;
	/** Return object metadata without fetching the body, or `null` if absent. */
	head(key: string): Promise<ObjectStat | null>;
	/**
	 * List keys under `prefix`.
	 *
	 * With `delimiter: "/"` the result groups keys the way S3 ListObjectsV2
	 * does: `objects` holds direct children, `prefixes` holds the common
	 * prefixes ("subdirectories"). With `limit`, implementations may return
	 * early after finding that many entries (used for cheap existence checks).
	 */
	list(prefix: string, options?: ListOptions): Promise<ListResult>;
}

export interface ObjectStat {
	size: number;
}

export interface ListOptions {
	delimiter?: string;
	limit?: number;
}

export interface ListResult {
	objects: { key: string; size: number }[];
	prefixes: string[];
}

/** Options accepted by {@link ../git-fs.createGitFs}. */
export interface GitFsOptions {
	/**
	 * Key prefix all paths are stored under, e.g. `"repos/alice/blog"`.
	 * Defaults to `""` (paths map directly to keys).
	 */
	prefix?: string;
}

export type Encoding = "utf8";

export interface ReadFileOptions {
	encoding?: Encoding;
}

export interface WriteFileOptions {
	encoding?: Encoding;
	mode?: number;
}

/**
 * The stat shape isomorphic-git expects. Object storage has no inodes,
 * owners, or modification times, so numeric fields are zero.
 */
export interface Stat {
	type: "file" | "dir";
	mode: number;
	size: number;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	uid: number;
	gid: number;
	dev: number;
	mtime: Date;
	ctime: Date;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/**
 * Promise-based filesystem client compatible with isomorphic-git's `fs`
 * option. Declared locally so the package has no dependency on
 * isomorphic-git itself.
 */
export interface GitFsClient {
	promises: {
		readFile(
			filepath: string,
			options?: ReadFileOptions | Encoding,
		): Promise<Uint8Array | string>;
		writeFile(
			filepath: string,
			data: Uint8Array | string,
			options?: WriteFileOptions | Encoding,
		): Promise<void>;
		unlink(filepath: string): Promise<void>;
		readdir(dirpath: string): Promise<string[]>;
		mkdir(dirpath: string, options?: { mode?: number }): Promise<void>;
		rmdir(dirpath: string): Promise<void>;
		stat(filepath: string): Promise<Stat>;
		lstat(filepath: string): Promise<Stat>;
		readlink(filepath: string): Promise<never>;
		symlink(target: string, filepath: string): Promise<never>;
		chmod(filepath: string, mode: number): Promise<void>;
	};
}
