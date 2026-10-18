import { createTwoFilesPatch } from "diff";
import git, { type WalkerEntry } from "isomorphic-git";
import { readBlobContent } from "../edge-utils.js";
import { getCommit, resolveCommit } from "./history.js";
import type { Repo } from "./types.js";

/** Text files larger than this get no patch (kind "too-large"). */
export const MAX_DIFF_TEXT_BYTES = 1024 * 1024;

export interface DiffFile {
	path: string;
	status: "added" | "modified" | "deleted";
	/**
	 * "text" has a unified `patch`; "binary" (a NUL byte on either side) and
	 * "too-large" (text over MAX_DIFF_TEXT_BYTES) don't — fetch the sides by
	 * path at each ref if they need showing.
	 */
	kind: "text" | "binary" | "too-large";
	additions: number;
	deletions: number;
	patch: string;
	/** Byte size before the change; absent for an added file. */
	oldSize?: number;
	/** Byte size after the change; absent for a deleted file. */
	newSize?: number;
}

export interface DiffResult {
	files: DiffFile[];
	totalAdditions: number;
	totalDeletions: number;
	totalFiles: number;
}

type BlobContent = ReturnType<typeof readBlobContent>;

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.length;
}

function unifiedPatch(
	path: string,
	before: BlobContent | null,
	after: BlobContent | null,
): string {
	const body = createTwoFilesPatch(
		before ? `a/${path}` : "/dev/null",
		after ? `b/${path}` : "/dev/null",
		before?.text ?? "",
		after?.text ?? "",
		"",
		"",
		{ context: 3 },
	).replace(/^=+\n/, "");
	return `diff --git a/${path} b/${path}\n${body}`;
}

/** One changed path: `before` null for an addition, `after` null for a deletion. */
function buildDiffFile(
	path: string,
	before: BlobContent | null,
	after: BlobContent | null,
): DiffFile {
	const kind: DiffFile["kind"] =
		before?.isBinary || after?.isBinary
			? "binary"
			: Math.max(before?.bytes.length ?? 0, after?.bytes.length ?? 0) >
					MAX_DIFF_TEXT_BYTES
				? "too-large"
				: "text";
	const isText = kind === "text";
	return {
		path,
		status: !before ? "added" : !after ? "deleted" : "modified",
		kind,
		additions: isText && after ? countContentLines(after.text) : 0,
		deletions: isText && before ? countContentLines(before.text) : 0,
		patch: isText ? unifiedPatch(path, before, after) : "",
		oldSize: before?.bytes.length,
		newSize: after?.bytes.length,
	};
}

/**
 * Every file that differs between two trees; `oldTreeOid` null diffs against
 * nothing (a root commit: every file is an addition).
 */
async function diffTrees(
	repo: Repo,
	oldTreeOid: string | null,
	newTreeOid: string,
): Promise<DiffResult> {
	const readSide = async (entry: WalkerEntry | null) => {
		if (!entry || (await entry.type()) !== "blob") return null;
		const { blob } = await git.readBlob({ ...repo, oid: await entry.oid() });
		return readBlobContent(blob);
	};
	const trees = oldTreeOid
		? [git.TREE({ ref: oldTreeOid }), git.TREE({ ref: newTreeOid })]
		: [git.TREE({ ref: newTreeOid })];
	const changes: (DiffFile | undefined)[] = await git.walk({
		...repo,
		trees,
		map: async (filepath, entries) => {
			const [oldEntry, newEntry] = oldTreeOid
				? [entries[0] ?? null, entries[1] ?? null]
				: [null, entries[0] ?? null];
			const [oldType, newType] = await Promise.all([
				oldEntry?.type(),
				newEntry?.type(),
			]);
			// Directories recurse; only blobs become diff entries.
			if (oldType !== "blob" && newType !== "blob") return undefined;
			if (oldEntry && newEntry && oldType === newType) {
				const [oldOid, newOid] = await Promise.all([
					oldEntry.oid(),
					newEntry.oid(),
				]);
				if (oldOid === newOid) return undefined;
			}
			const [before, after] = await Promise.all([
				readSide(oldEntry),
				readSide(newEntry),
			]);
			return before || after
				? buildDiffFile(filepath, before, after)
				: undefined;
		},
	});
	const files = (changes ?? []).filter((file): file is DiffFile => !!file);
	return {
		files,
		totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
		totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
		totalFiles: files.length,
	};
}

/** The diff a single commit introduced (against its first parent). */
export async function getCommitDiff(
	repo: Repo,
	commitSha: string,
): Promise<DiffResult> {
	const { commit } = await getCommit(repo, commitSha);
	const parent = commit.parent[0];
	const parentTree = parent
		? (await getCommit(repo, parent)).commit.tree
		: null;
	return diffTrees(repo, parentTree, commit.tree);
}

/**
 * What `compareRef` changed since it diverged from `baseRef` — a pull
 * request's diff (git's three-dot `base...compare`): compared against their
 * merge base, so commits that landed on `baseRef` since the branch point
 * don't show up as reverted. Throws GitRefNotFoundError for a missing ref.
 */
export async function getDiffBetweenRefs(
	repo: Repo,
	baseRef: string,
	compareRef: string,
): Promise<DiffResult> {
	const [base, compare] = await Promise.all([
		resolveCommit(repo, baseRef),
		resolveCommit(repo, compareRef),
	]);
	const [mergeBase] = await git.findMergeBase({
		...repo,
		oids: [base.oid, compare.oid],
	});
	const baseTree =
		mergeBase === undefined
			? null
			: mergeBase === base.oid
				? base.commit.tree
				: (await getCommit(repo, mergeBase)).commit.tree;
	return diffTrees(repo, baseTree, compare.commit.tree);
}
