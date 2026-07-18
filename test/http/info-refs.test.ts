import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { handleInfoRefs } from "../../src/http/info-refs.js";
import { parsePktLines } from "../../src/http/pkt-line.js";
import { createGitFs, MemoryObjectStore } from "../../src/index.js";
import {
	authorNow,
	commitFilesToBare,
	type Repo,
} from "../../src/ops/index.js";

const author = authorNow("Test", "test@example.com");

function makeRepo(): Repo {
	const fs = createGitFs(new MemoryObjectStore());
	return { fs, gitdir: "repos/alice/blog/git", cache: {} };
}

describe("handleInfoRefs", () => {
	it("advertises the empty-repo capability sentinel", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const result = await handleInfoRefs(repo, { service: "git-upload-pack" });

		expect(result.status).toBe(200);
		expect(result.headers["Content-Type"]).toBe(
			"application/x-git-upload-pack-advertisement",
		);
		const lines = parsePktLines(result.body);
		expect(lines[0]).toBe("# service=git-upload-pack\n");
		expect(lines[1]).toBeNull(); // flush
		expect(lines[2]).toContain("capabilities^{}");
		expect(lines[lines.length - 1]).toBeNull();
	});

	it("advertises HEAD, branches, and tags with capabilities on the first ref", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});
		await commitFilesToBare(repo, {
			branch: "main",
			message: "first\n",
			author,
			files: [{ path: "a.txt", content: "1\n" }],
		});
		await git.tag({ ...repo, ref: "v1.0.0" });

		const result = await handleInfoRefs(repo, {
			service: "git-upload-pack",
			defaultBranch: "main",
		});

		const lines = parsePktLines(result.body).filter(
			(l): l is string => l !== null,
		);
		expect(lines[0]).toBe("# service=git-upload-pack\n");
		const headLine = lines[1] as string;
		expect(headLine).toContain("HEAD");
		expect(headLine).toContain("symref=HEAD:refs/heads/main");
		expect(headLine).toContain("side-band-64k");
		expect(lines.some((l) => l.includes("refs/heads/main"))).toBe(true);
		expect(lines.some((l) => l.includes("refs/tags/v1.0.0"))).toBe(true);
	});

	it("advertises delete-refs/report-status for git-receive-pack", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const result = await handleInfoRefs(repo, { service: "git-receive-pack" });
		expect(result.headers["Content-Type"]).toBe(
			"application/x-git-receive-pack-advertisement",
		);
		const lines = parsePktLines(result.body);
		const sentinel = lines.find((l) => l?.includes("capabilities^{}"));
		expect(sentinel).toContain("delete-refs");
		expect(sentinel).toContain("report-status");
	});

	it("honors a custom agent string", async () => {
		const repo = makeRepo();
		await git.init({
			...repo,
			dir: repo.gitdir,
			bare: true,
			defaultBranch: "main",
		});

		const result = await handleInfoRefs(repo, {
			service: "git-upload-pack",
			agent: "my-app/1.0",
		});
		const lines = parsePktLines(result.body);
		expect(lines.find((l) => l?.includes("capabilities^{}"))).toContain(
			"agent=my-app/1.0",
		);
	});
});
