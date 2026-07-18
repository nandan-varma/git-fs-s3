import { describe, expect, it } from "vitest";
import { createGitFs, MemoryObjectStore } from "../src/index.js";

function setup(prefix?: string) {
	const store = new MemoryObjectStore();
	const fs = createGitFs(store, { prefix });
	return { store, fs: fs.promises };
}

describe("readFile / writeFile", () => {
	it("round-trips binary data", async () => {
		const { fs } = setup();
		const data = new Uint8Array([0, 1, 2, 255]);
		await fs.writeFile("/repo/objects/ab/cdef", data);
		const read = await fs.readFile("/repo/objects/ab/cdef");
		expect(read).toEqual(data);
	});

	it("round-trips utf8 strings", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo/HEAD", "ref: refs/heads/main\n", "utf8");
		expect(await fs.readFile("/repo/HEAD", "utf8")).toBe(
			"ref: refs/heads/main\n",
		);
		expect(await fs.readFile("/repo/HEAD", { encoding: "utf8" })).toBe(
			"ref: refs/heads/main\n",
		);
	});

	it("throws ENOENT with code property for missing files", async () => {
		const { fs } = setup();
		await expect(fs.readFile("/missing")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("applies the configured key prefix", async () => {
		const { fs, store } = setup("repos/alice/blog");
		await fs.writeFile("/git/HEAD", "x");
		expect(await store.head("repos/alice/blog/git/HEAD")).not.toBeNull();
	});
});

describe("unlink", () => {
	it("deletes files and then ENOENTs", async () => {
		const { fs } = setup();
		await fs.writeFile("/a", "1");
		await fs.unlink("/a");
		await expect(fs.readFile("/a")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("throws ENOENT for missing files", async () => {
		const { fs } = setup();
		await expect(fs.unlink("/nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("readdir", () => {
	it("lists immediate children only", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo/refs/heads/main", "a");
		await fs.writeFile("/repo/refs/heads/dev", "b");
		await fs.writeFile("/repo/refs/tags/v1", "c");
		await fs.writeFile("/repo/HEAD", "d");
		expect(await fs.readdir("/repo/refs/heads")).toEqual(["dev", "main"]);
		expect(await fs.readdir("/repo/refs")).toEqual(["heads", "tags"]);
		expect(await fs.readdir("/repo")).toEqual(["HEAD", "refs"]);
	});

	it("throws ENOENT for missing dirs and ENOTDIR for files", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo/HEAD", "x");
		await expect(fs.readdir("/repo/nope")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(fs.readdir("/repo/HEAD")).rejects.toMatchObject({
			code: "ENOTDIR",
		});
	});
});

describe("stat / lstat", () => {
	it("stats files with size", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo/config", "12345");
		const s = await fs.stat("/repo/config");
		expect(s.isFile()).toBe(true);
		expect(s.isDirectory()).toBe(false);
		expect(s.size).toBe(5);
	});

	it("stats implicit directories", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo/objects/ab/cd", "x");
		const s = await fs.stat("/repo/objects");
		expect(s.isDirectory()).toBe(true);
		expect(s.isSymbolicLink()).toBe(false);
	});

	it("throws ENOENT otherwise", async () => {
		const { fs } = setup();
		await expect(fs.stat("/ghost")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat("/ghost")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("mkdir / rmdir / chmod / symlinks", () => {
	it("mkdir is a no-op that always succeeds", async () => {
		const { fs } = setup();
		await expect(fs.mkdir("/anything")).resolves.toBeUndefined();
		await expect(fs.mkdir("/anything")).resolves.toBeUndefined();
	});

	it("rmdir throws ENOTEMPTY for non-empty dirs", async () => {
		const { fs } = setup();
		await fs.writeFile("/dir/file", "x");
		await expect(fs.rmdir("/dir")).rejects.toMatchObject({
			code: "ENOTEMPTY",
		});
		await fs.unlink("/dir/file");
		await expect(fs.rmdir("/dir")).resolves.toBeUndefined();
	});

	it("chmod is a no-op; symlinks are unsupported", async () => {
		const { fs } = setup();
		await fs.writeFile("/f", "x");
		await expect(fs.chmod("/f", 0o755)).resolves.toBeUndefined();
		await expect(fs.readlink("/f")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.symlink("/f", "/link")).rejects.toMatchObject({
			code: "EPERM",
		});
	});
});

describe("path handling", () => {
	it("normalizes dots and duplicate slashes", async () => {
		const { fs } = setup();
		await fs.writeFile("/repo//./objects/../HEAD", "x");
		expect(await fs.readFile("/repo/HEAD", "utf8")).toBe("x");
	});

	it("rejects traversal above the root", async () => {
		const { fs } = setup("scoped");
		await expect(fs.readFile("/../escape")).rejects.toMatchObject({
			code: "EINVAL",
		});
	});
});
