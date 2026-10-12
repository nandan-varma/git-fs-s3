import { describe, expect, it } from "vitest";
import {
	classifyGitdirPath,
	isMutableGitdirEntry,
	parseLooseObjectPath,
} from "../src/git-layout.js";

const oid = "ab".padEnd(40, "c");

describe("classifyGitdirPath", () => {
	it.each([
		["HEAD", "head"],
		["config", "config"],
		["refs/heads/main", "refs"],
		["refs/heads/", "refs"],
		["objects/", "objects-dir"],
		["objects/pack/", "pack-dir"],
		["objects/pack/pack-1.idx", "pack-file"],
		[`objects/${oid.slice(0, 2)}/${oid.slice(2)}`, "loose-object"],
		["objects/info/packs", "other"],
		["objects/zz/notanobjectnameatallnotanobjectname00", "other"],
		["description", "other"],
	])("%s is %s", (path, kind) => {
		expect(classifyGitdirPath(path).kind).toBe(kind);
	});

	it("marks refs, HEAD and listings mutable but objects and packs not", () => {
		expect(isMutableGitdirEntry(classifyGitdirPath("HEAD"))).toBe(true);
		expect(isMutableGitdirEntry(classifyGitdirPath("refs/heads/"))).toBe(true);
		expect(isMutableGitdirEntry(classifyGitdirPath("objects/pack/"))).toBe(
			true,
		);
		expect(
			isMutableGitdirEntry(classifyGitdirPath("objects/pack/p.pack")),
		).toBe(false);
	});
});

describe("parseLooseObjectPath", () => {
	it("splits a loose-object path into gitdir and oid", () => {
		expect(
			parseLooseObjectPath(
				`repos/a/b/git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
			),
		).toEqual({ gitdir: "repos/a/b/git", oid });
	});

	it("rejects non-object paths, including refs that look like one", () => {
		expect(parseLooseObjectPath("repos/a/b/git/refs/heads/main")).toBeNull();
		expect(
			parseLooseObjectPath(`g/refs/heads/objects/${oid.slice(0, 2)}/x`),
		).toBeNull();
	});
});
