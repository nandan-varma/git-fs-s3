import { describe, expect, it } from "vitest";
import {
	isFullSha,
	isSafeBranchName,
	isSafeFullRefName,
	isSafeRefName,
	isSafeRepoPath,
	qualifyBranchRef,
} from "../src/index.js";

const SHA = "a".repeat(40);

describe("isSafeFullRefName", () => {
	it("accepts qualified branch and tag refs", () => {
		expect(isSafeFullRefName("refs/heads/main")).toBe(true);
		expect(isSafeFullRefName("refs/heads/feature/x-1")).toBe(true);
		expect(isSafeFullRefName("refs/tags/v1.0.0")).toBe(true);
	});

	it("rejects unqualified, traversal-laden, and malformed refs", () => {
		expect(isSafeFullRefName("main")).toBe(false);
		expect(isSafeFullRefName("refs/heads/../../../etc/passwd")).toBe(false);
		expect(isSafeFullRefName("refs/heads/a..b")).toBe(false);
		expect(isSafeFullRefName("refs/heads/a b")).toBe(false);
		expect(isSafeFullRefName("refs/heads/a.lock")).toBe(false);
		expect(isSafeFullRefName("refs/heads/a\\b")).toBe(false);
		expect(isSafeFullRefName("refs/remotes/origin/main")).toBe(false);
	});
});

describe("isSafeBranchName", () => {
	it("accepts ordinary branch names", () => {
		expect(isSafeBranchName("main")).toBe(true);
		expect(isSafeBranchName("feature/nested-name")).toBe(true);
		expect(isSafeBranchName("v1.2.3")).toBe(true);
	});

	it("rejects prefixed, SHA-shaped, HEAD, and traversal names", () => {
		expect(isSafeBranchName("")).toBe(false);
		expect(isSafeBranchName("HEAD")).toBe(false);
		expect(isSafeBranchName("refs/heads/main")).toBe(false);
		expect(isSafeBranchName(SHA)).toBe(false);
		expect(isSafeBranchName("../escape")).toBe(false);
		expect(isSafeBranchName("a..b")).toBe(false);
		expect(isSafeBranchName(".hidden")).toBe(false);
		expect(isSafeBranchName("name.lock")).toBe(false);
		expect(isSafeBranchName("a@{b}")).toBe(false);
	});
});

describe("isSafeRefName / isFullSha", () => {
	it("accepts both branch names and full SHAs", () => {
		expect(isSafeRefName("main")).toBe(true);
		expect(isSafeRefName(SHA)).toBe(true);
		expect(isSafeRefName(SHA.toUpperCase())).toBe(true);
		expect(isFullSha(SHA)).toBe(true);
		expect(isFullSha(SHA.slice(1))).toBe(false);
		expect(isSafeRefName("../nope")).toBe(false);
	});
});

describe("isSafeRepoPath", () => {
	it("accepts relative paths and rejects escapes", () => {
		expect(isSafeRepoPath("src/index.ts")).toBe(true);
		expect(isSafeRepoPath("README.md")).toBe(true);
		expect(isSafeRepoPath("/abs/path")).toBe(false);
		expect(isSafeRepoPath("a/../b")).toBe(false);
		expect(isSafeRepoPath(".git/config")).toBe(false);
		expect(isSafeRepoPath(".GIT/config")).toBe(false);
		expect(isSafeRepoPath("a\0b")).toBe(false);
		// A directory merely *containing* .git midway is fine.
		expect(isSafeRepoPath("vendor/.gitignore")).toBe(true);
	});
});

describe("qualifyBranchRef", () => {
	it("qualifies bare names and leaves everything else alone", () => {
		expect(qualifyBranchRef("main")).toBe("refs/heads/main");
		expect(qualifyBranchRef("refs/heads/main")).toBe("refs/heads/main");
		expect(qualifyBranchRef("refs/tags/v1")).toBe("refs/tags/v1");
		expect(qualifyBranchRef("HEAD")).toBe("HEAD");
		expect(qualifyBranchRef(SHA)).toBe(SHA);
	});
});
