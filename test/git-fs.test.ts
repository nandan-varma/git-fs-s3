import { describe, expect, it, vi } from "vitest";
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

describe("git-aware optimizations", () => {
	const oid = "cdef0123456789abcdef0123456789abcdef01";
	const gitdir = "repos/alice/blog/git";

	function optimizedSetup() {
		const store = new MemoryObjectStore();
		const gitFs = createGitFs(store, { looseObjectHints: true });
		return { store, gitFs, fs: gitFs.promises };
	}

	it("structural absence short-circuits readFile and stat with zero store calls", async () => {
		const store = new MemoryObjectStore();
		const gitFs = createGitFs(store, {
			isStructurallyAbsent: (p) => p === `${gitdir}/packed-refs`,
		});
		const getSpy = vi.spyOn(store, "get");
		const headSpy = vi.spyOn(store, "head");
		const listSpy = vi.spyOn(store, "list");

		await expect(
			gitFs.promises.readFile(`${gitdir}/packed-refs`),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			gitFs.promises.stat(`${gitdir}/packed-refs`),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(getSpy).not.toHaveBeenCalled();
		expect(headSpy).not.toHaveBeenCalled();
		expect(listSpy).not.toHaveBeenCalled();

		// Other paths are unaffected.
		await gitFs.promises.writeFile(`${gitdir}/HEAD`, "x");
		expect(await gitFs.promises.readFile(`${gitdir}/HEAD`, "utf8")).toBe("x");
	});

	it("detectLooseObjects registers a 'none' hint that short-circuits loose reads", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await store.put(`${gitdir}/objects/pack/pack-1.pack`, new Uint8Array([1]));
		await gitFs.detectLooseObjects(gitdir);

		const getSpy = vi.spyOn(store, "get");
		const headSpy = vi.spyOn(store, "head");
		const listSpy = vi.spyOn(store, "list");
		await expect(
			fs.readFile(`${gitdir}/objects/aa/${oid}`),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(`${gitdir}/objects/aa/${oid}`)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(getSpy).not.toHaveBeenCalled();
		expect(headSpy).not.toHaveBeenCalled();
		expect(listSpy).not.toHaveBeenCalled();
	});

	it("detects 'present' when loose objects exist", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await store.put(`${gitdir}/objects/aa/${oid}`, new Uint8Array([9]));
		await gitFs.detectLooseObjects(gitdir);

		expect(await fs.readFile(`${gitdir}/objects/aa/${oid}`)).toEqual(
			new Uint8Array([9]),
		);
	});

	it("a loose write flips the hint to 'present' immediately", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await gitFs.detectLooseObjects(gitdir); // empty repo -> "none"

		await fs.writeFile(`${gitdir}/objects/aa/${oid}`, new Uint8Array([7]));
		const getSpy = vi.spyOn(store, "get");
		expect(await fs.readFile(`${gitdir}/objects/aa/${oid}`)).toEqual(
			new Uint8Array([7]),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
	});

	it("stat skips the directory probe for absent loose-object leaves", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await store.put(`${gitdir}/objects/aa/${oid}`, new Uint8Array([1]));
		await gitFs.detectLooseObjects(gitdir); // hint: present

		const listSpy = vi.spyOn(store, "list");
		await expect(fs.stat(`${gitdir}/objects/ee/${oid}`)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(listSpy).not.toHaveBeenCalled();
	});

	it("never short-circuits a scope that was not registered", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await gitFs.detectLooseObjects(gitdir); // registers only this gitdir

		// A ref that merely looks like a loose object, under a different scope.
		const trap = `${gitdir}/refs/heads/objects/aa/${oid}`;
		await store.put(trap, new Uint8Array([4]));
		expect(await fs.readFile(trap)).toEqual(new Uint8Array([4]));
	});

	it("prefetchPacks warms every pack file and tolerates a missing pack dir", async () => {
		const { store, gitFs } = optimizedSetup();
		await store.put(`${gitdir}/objects/pack/pack-1.pack`, new Uint8Array([1]));
		await store.put(`${gitdir}/objects/pack/pack-1.idx`, new Uint8Array([2]));
		const getSpy = vi.spyOn(store, "get");

		await gitFs.prefetchPacks(gitdir);
		expect(getSpy).toHaveBeenCalledTimes(2);

		// Missing pack dir: no throw.
		const empty = createGitFs(new MemoryObjectStore(), {
			looseObjectHints: true,
		});
		await expect(empty.prefetchPacks("nothing/here")).resolves.toBeUndefined();
	});

	it("prefetchPacks bails out beyond maxPacks * 2 entries but still detects hints", async () => {
		const { store, gitFs } = optimizedSetup();
		for (let i = 0; i < 5; i++) {
			await store.put(
				`${gitdir}/objects/pack/pack-${i}.pack`,
				new Uint8Array([i]),
			);
		}
		const getSpy = vi.spyOn(store, "get");
		const listSpy = vi.spyOn(store, "list");

		await gitFs.prefetchPacks(gitdir, { maxPacks: 2 });
		expect(getSpy).not.toHaveBeenCalled();
		expect(listSpy).toHaveBeenCalled(); // detectLooseObjects still ran
	});

	it("invalidate clears hints and forwards to the store's invalidate", async () => {
		const store = new MemoryObjectStore();
		const invalidateSpy = vi.fn();
		const gitFs = createGitFs(
			Object.assign(store, { invalidate: invalidateSpy }),
			{ looseObjectHints: true },
		);
		await gitFs.detectLooseObjects(gitdir); // "none"

		gitFs.invalidate(gitdir);
		const getSpy = vi.spyOn(store, "get");
		// Hint gone: the read reaches the store again.
		await expect(
			gitFs.promises.readFile(`${gitdir}/objects/aa/${oid}`),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(invalidateSpy).toHaveBeenCalledWith(gitdir);
	});

	it("does not re-derive a hint that is already live", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await gitFs.detectLooseObjects(gitdir); // "none"
		await fs.writeFile(`${gitdir}/objects/aa/${oid}`, new Uint8Array([1]));

		// Re-detection must not resurrect "none" from a fresh (or cached) list.
		const listSpy = vi.spyOn(store, "list");
		await gitFs.detectLooseObjects(gitdir);
		expect(listSpy).not.toHaveBeenCalled();
		expect(await fs.readFile(`${gitdir}/objects/aa/${oid}`)).toEqual(
			new Uint8Array([1]),
		);
	});

	it("swallows detection errors and leaves the hint unknown", async () => {
		const { store, gitFs, fs } = optimizedSetup();
		await store.put(`${gitdir}/objects/aa/${oid}`, new Uint8Array([2]));
		vi.spyOn(store, "list").mockRejectedValueOnce(new Error("outage"));

		await expect(gitFs.detectLooseObjects(gitdir)).resolves.toBeUndefined();
		// No hint registered: reads take the normal path and still work.
		expect(await fs.readFile(`${gitdir}/objects/aa/${oid}`)).toEqual(
			new Uint8Array([2]),
		);
	});

	it("reports hint detection through onNote", async () => {
		const notes: string[] = [];
		const store = new MemoryObjectStore();
		const gitFs = createGitFs(store, {
			looseObjectHints: true,
			onNote: (m) => notes.push(m),
		});
		await gitFs.detectLooseObjects(gitdir);
		expect(notes).toEqual([`loose objects none under ${gitdir}`]);
	});
});
