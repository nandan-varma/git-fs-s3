import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { createGitFs, MemoryObjectStore } from "../src/index.js";
import {
	findTreeEntry,
	getCommitDiff,
	getSubmodules,
	listTreeEntries,
	parseGitmodules,
	type Repo,
} from "../src/ops/index.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const author = { name: "T", email: "t@t", timestamp: 1, timezoneOffset: 0 };
async function setup() {
	const repo: Repo = {
		fs: createGitFs(new MemoryObjectStore()),
		gitdir: "git",
		cache: {},
	};
	await git.init({ ...repo, dir: "git", bare: true });
	return repo;
}
async function commit(
	repo: Repo,
	tree: Parameters<typeof git.writeTree>[0]["tree"],
	parent: string[] = [],
) {
	return git.writeCommit({
		...repo,
		commit: {
			tree: await git.writeTree({ ...repo, tree }),
			parent,
			author,
			committer: author,
			message: "submodule\n",
		},
	});
}
const link = (oid: string) => ({
	mode: "160000",
	type: "commit" as const,
	path: "lib",
	oid,
});

describe("submodule entries and diffs", () => {
	it("exposes gitlinks and never reads their external commit", async () => {
		const repo = await setup();
		const first = await commit(repo, [link(A)]);
		const { commit: c } = await git.readCommit({ ...repo, oid: first });
		expect(await listTreeEntries(repo, c.tree)).toEqual([link(A)]);
		expect(await findTreeEntry(repo, c.tree, "lib")).toEqual(link(A));
		const added = (await getCommitDiff(repo, first)).files[0];
		expect(added).toMatchObject({
			path: "lib",
			kind: "submodule",
			status: "added",
			newEntry: { type: "commit", oid: A },
			additions: 0,
			deletions: 0,
		});
		expect(added?.patch).toContain(`+Subproject commit ${A}`);
		const next = await commit(repo, [link(B)], [first]);
		expect((await getCommitDiff(repo, next)).files[0]).toMatchObject({
			kind: "submodule",
			status: "modified",
			oldEntry: { oid: A },
			newEntry: { oid: B },
		});
		const unchanged = await commit(repo, [link(B)], [next]);
		expect((await getCommitDiff(repo, unchanged)).files).toEqual([]);
		const deleted = await commit(repo, [], [next]);
		expect((await getCommitDiff(repo, deleted)).files[0]).toMatchObject({
			kind: "submodule",
			status: "deleted",
			oldEntry: { oid: B },
		});
	});
	it("shows conversions between a submodule, file, and directory", async () => {
		const repo = await setup();
		const blob = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode("file"),
		});
		const directory = await git.writeTree({
			...repo,
			tree: [{ path: "child", mode: "100644", type: "blob", oid: blob }],
		});
		for (const entry of [
			{ path: "lib", mode: "100644", type: "blob" as const, oid: blob },
			{ path: "lib", mode: "040000", type: "tree" as const, oid: directory },
		]) {
			const first = await commit(repo, [entry]);
			const next = await commit(repo, [link(A)], [first]);
			expect((await getCommitDiff(repo, next)).files).toContainEqual(
				expect.objectContaining({
					path: "lib",
					kind: "submodule",
					oldEntry: expect.objectContaining({ type: entry.type }),
					newEntry: expect.objectContaining({ type: "commit" }),
				}),
			);
			const back = await commit(repo, [entry], [next]);
			expect((await getCommitDiff(repo, back)).files).toContainEqual(
				expect.objectContaining({
					path: "lib",
					kind: "submodule",
					oldEntry: expect.objectContaining({ type: "commit" }),
					newEntry: expect.objectContaining({ type: entry.type }),
				}),
			);
		}
	});
	it("reads configuration at the requested revision and tolerates a missing file", async () => {
		const repo = await setup();
		const absent = await commit(repo, [link(A)]);
		expect(await getSubmodules(repo, absent)).toEqual([]);
		const blob = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode(
				'[submodule "lib"]\npath=lib\nurl=../lib.git\n',
			),
		});
		const configured = await commit(
			repo,
			[
				link(A),
				{ path: ".gitmodules", mode: "100644", type: "blob", oid: blob },
			],
			[absent],
		);
		expect(await getSubmodules(repo, configured)).toEqual([
			{ name: "lib", path: "lib", url: "../lib.git" },
		]);
	});
});

describe(".gitmodules parsing", () => {
	it("handles quoted values, comments, escapes, CRLF, continuations, and repeated sections", () => {
		expect(
			parseGitmodules(
				'[Submodule "lib\\\\name"]\r\n path = "vendor/my lib" # comment\r\n url = "https://example.com/a;#b.git"\r\n[submodule "lib\\\\name"]\r\n url = ../my\\\n-lib.git\r\n',
			),
		).toEqual([
			{ name: "lib\\name", path: "vendor/my lib", url: "../my-lib.git" },
		]);
	});
	it("does not expand includes and ignores incomplete, unsafe, or ambiguous paths", () => {
		expect(
			parseGitmodules(
				'[include]\npath=/etc/private\n[submodule "a"]\npath=../escape\nurl=bad\n[submodule "b"]\npath=lib\nurl=a\n[submodule "c"]\npath=lib\nurl=b\n[submodule "d"]\npath=x\nurl="unterminated\n[submodule "e"]\npath=.git/modules/x\nurl=anything',
			),
		).toEqual([]);
	});
	it("uses no object prototype keys", () => {
		expect(
			parseGitmodules(
				'[submodule "__proto__"]\npath=constructor\nurl=../repo.git',
			),
		).toEqual([{ name: "__proto__", path: "constructor", url: "../repo.git" }]);
	});
});
