import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import {
	createGitFs,
	GitRefNotFoundError,
	MemoryObjectStore,
} from "../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	getCommitLog,
	getFileContent,
	getTreeFromRef,
	listTags,
	type Repo,
	resolveCommit,
} from "../src/ops/index.js";

const author = authorNow("Test", "test@example.com");

async function repoWithTwoCommits() {
	const repo: Repo = {
		fs: createGitFs(new MemoryObjectStore()),
		gitdir: "repos/alice/tags/git",
		cache: {},
	};
	await git.init({
		...repo,
		dir: repo.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	const commit = (content: string) =>
		commitFilesToBare(repo, {
			branch: "main",
			message: `${content}\n`,
			author,
			files: [{ path: "VERSION", content: `${content}\n` }],
		});
	const first = await commit("1.0");
	const second = await commit("2.0");
	return { repo, first, second };
}

describe("tags", () => {
	it("resolves lightweight and annotated tags anywhere a branch works", async () => {
		const { repo, first, second } = await repoWithTwoCommits();
		await git.tag({ ...repo, ref: "v1", object: first });
		await git.annotatedTag({
			...repo,
			ref: "v2",
			object: second,
			message: "release 2",
			tagger: { ...author, timestamp: 0, timezoneOffset: 0 },
		});

		expect((await resolveCommit(repo, "v1")).oid).toBe(first);
		expect((await resolveCommit(repo, "v2")).oid).toBe(second);
		expect(
			new TextDecoder().decode(await getFileContent(repo, "VERSION", "v1")),
		).toBe("1.0\n");
		expect(
			(await getTreeFromRef(repo, { ref: "v2" })).map((e) => e.path),
		).toEqual(["VERSION"]);
		expect((await getCommitLog(repo, { ref: "v2", depth: 5 })).length).toBe(2);
	});

	it("prefers a branch over a tag with the same name", async () => {
		const { repo, first, second } = await repoWithTwoCommits();
		await git.tag({ ...repo, ref: "main", object: first });
		expect((await resolveCommit(repo, "main")).oid).toBe(second);
	});

	it("still reports a name that is neither a branch nor a tag", async () => {
		const { repo } = await repoWithTwoCommits();
		await expect(resolveCommit(repo, "nope")).rejects.toBeInstanceOf(
			GitRefNotFoundError,
		);
	});

	it("lists tags with their peeled commits, in version order", async () => {
		const { repo, first, second } = await repoWithTwoCommits();
		await git.tag({ ...repo, ref: "v10", object: second });
		await git.tag({ ...repo, ref: "v9", object: first });
		await git.annotatedTag({
			...repo,
			ref: "v9.1",
			object: second,
			message: "annotated",
			tagger: { ...author, timestamp: 0, timezoneOffset: 0 },
		});

		const tags = await listTags(repo);
		expect(tags.map((t) => [t.name, t.commit])).toEqual([
			["v9", first],
			["v9.1", second],
			["v10", second],
		]);
		expect(tags[0]?.tagObject).toBeUndefined();
		expect(tags[1]?.tagObject).toMatch(/^[0-9a-f]{40}$/);
	});
});
