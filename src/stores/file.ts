/**
 * A disk-backed {@link ObjectStore} for local development and tests that
 * should survive restarts: the same semantics as `MemoryObjectStore`, which
 * serves every read, with each write mirrored to a file under `root` and the
 * whole tree loaded back on first use. Node-only (`git-fs-s3/node`); keep it
 * out of edge builds. Not for production: it holds everything in memory and
 * is single-process.
 *
 * Keys map to paths under `root`. A key that would escape it (`../x`) is
 * rejected, failing closed.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ListOptions,
	ListResult,
	ObjectStat,
	ObjectStore,
} from "../types.js";
import { MemoryObjectStore } from "./memory.js";

export class FileObjectStore implements ObjectStore {
	private readonly memory = new MemoryObjectStore();
	private loaded: Promise<void> | null = null;

	constructor(private readonly root: string) {}

	private fileFor(key: string): string {
		const file = path.resolve(this.root, key);
		if (!file.startsWith(path.resolve(this.root) + path.sep)) {
			throw new Error(`Storage key escapes the store root: ${key}`);
		}
		return file;
	}

	private ready(): Promise<void> {
		this.loaded ??= this.load(this.root);
		return this.loaded;
	}

	private async load(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await this.load(full);
			} else if (entry.isFile()) {
				const key = path.relative(this.root, full).split(path.sep).join("/");
				await this.memory.put(key, new Uint8Array(await readFile(full)));
			}
		}
	}

	async get(key: string): Promise<Uint8Array | null> {
		await this.ready();
		return this.memory.get(key);
	}

	async getRange(
		key: string,
		start: number,
		end: number,
	): Promise<Uint8Array | null> {
		await this.ready();
		return this.memory.getRange(key, start, end);
	}

	async head(key: string): Promise<ObjectStat | null> {
		await this.ready();
		return this.memory.head(key);
	}

	async list(prefix: string, options?: ListOptions): Promise<ListResult> {
		await this.ready();
		return this.memory.list(prefix, options);
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		await this.ready();
		const file = this.fileFor(key);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, data);
		await this.memory.put(key, data);
	}

	async delete(key: string): Promise<void> {
		await this.ready();
		await rm(this.fileFor(key), { force: true });
		await this.memory.delete(key);
	}
}
