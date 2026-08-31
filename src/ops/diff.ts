import { createTwoFilesPatch } from "diff";
import git from "isomorphic-git";
import { readBlobContent, toBase64 } from "../edge-utils.js";
import { qualifyBranchRef } from "../refs.js";
import { getCommit } from "./history.js";
import type { Repo } from "./types.js";

export interface DiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	patch: string;
	oldPath?: string;
	isBinary?: boolean;
	oldContent?: string;
	newContent?: string;
	oldSize?: number;
	newSize?: number;
}

export interface DiffResult {
	files: DiffFile[];
	totalAdditions: number;
	totalDeletions: number;
	totalFiles: number;
}

/** Binary detection via null-byte heuristic. */
function detectBlobContent(blob: Uint8Array): {
	isBinary: boolean;
	text: string;
	bytes: Uint8Array;
} {
	return readBlobContent(blob);
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

function createUnifiedPatch(params: {
	path: string;
	before: string;
	after: string;
	oldPath?: string;
	newPath?: string;
}): string {
	const oldPath = params.oldPath ?? `a/${params.path}`;
	const newPath = params.newPath ?? `b/${params.path}`;
	const patchBody = createTwoFilesPatch(
		oldPath,
		newPath,
		params.before,
		params.after,
		"",
		"",
		{ context: 3 },
	).replace(/^=+\n/, "");

	return `diff --git a/${params.path} b/${params.path}\n${patchBody}`;
}

function summarizeDiff(files: DiffFile[]): DiffResult {
	return {
		files,
		totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
		totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
		totalFiles: files.length,
	};
}

type BlobContent = { isBinary: boolean; text: string; bytes: Uint8Array };

/**
 * Build one `DiffFile` from a path's before/after content — `before: null`
 * for an added file, `after: null` for a deleted one, both present for a
 * modification. The shared core of walkTreeDiff's three branches and
 * getCommitDiff's root-commit case (every file is an addition there, with no
 * two-tree walk to drive it), which each used to duplicate this field
 * construction independently.
 */
function buildDiffFile(
	path: string,
	status: DiffFile["status"],
	before: BlobContent | null,
	after: BlobContent | null,
): DiffFile {
	const isBinary = !!(before?.isBinary || after?.isBinary);
	return {
		path,
		status,
		additions: !isBinary && after ? countContentLines(after.text) : 0,
		deletions: !isBinary && before ? countContentLines(before.text) : 0,
		patch: isBinary
			? ""
			: createUnifiedPatch({
					path,
					before: before?.text ?? "",
					after: after?.text ?? "",
					oldPath: before ? undefined : "/dev/null",
					newPath: after ? undefined : "/dev/null",
				}),
		isBinary,
		oldContent: before && isBinary ? toBase64(before.bytes) : undefined,
		newContent: after && isBinary ? toBase64(after.bytes) : undefined,
		oldSize: before?.bytes.length,
		newSize: after?.bytes.length,
	};
}

/**
 * Walk two trees (oldOid -> newOid) and return one DiffFile per changed path
 * — the shared core of both {@link getCommitDiff} (parent -> commit) and
 * {@link getDiffBetweenRefs} (base -> compare).
 */
async function walkTreeDiff(
	repo: Repo,
	oldOid: string,
	newOid: string,
): Promise<DiffFile[]> {
	const changes = await git.walk({
		...repo,
		trees: [git.TREE({ ref: oldOid }), git.TREE({ ref: newOid })],
		map: async (filepath, [A, B]) => {
			const [typeA, typeB] = await Promise.all([A?.type(), B?.type()]);

			if (typeA === "tree" || typeB === "tree") return;

			if (typeA && !typeB) {
				const oidA = A ? await A.oid() : "";
				const { blob } = await git.readBlob({ ...repo, oid: oidA });
				const before = detectBlobContent(blob);
				return buildDiffFile(filepath, "deleted", before, null);
			}

			if (!typeA && typeB) {
				const oidB = B ? await B.oid() : "";
				const { blob } = await git.readBlob({ ...repo, oid: oidB });
				const after = detectBlobContent(blob);
				return buildDiffFile(filepath, "added", null, after);
			}

			const [oidA, oidB] = await Promise.all([
				A ? A.oid() : Promise.resolve(""),
				B ? B.oid() : Promise.resolve(""),
			]);

			if (oidA !== oidB) {
				const [{ blob: blobA }, { blob: blobB }] = await Promise.all([
					git.readBlob({ ...repo, oid: oidA }),
					git.readBlob({ ...repo, oid: oidB }),
				]);
				const before = detectBlobContent(blobA);
				const after = detectBlobContent(blobB);
				return buildDiffFile(filepath, "modified", before, after);
			}

			return null;
		},
	});

	return (changes ?? []).filter(
		(c: DiffFile | null | undefined): c is DiffFile =>
			c !== null && c !== undefined,
	);
}

/** The diff a single commit introduced (against its first parent). */
export async function getCommitDiff(
	repo: Repo,
	commitSha: string,
): Promise<DiffResult> {
	try {
		const commit = await getCommit(repo, commitSha);
		const parent = commit.commit.parent[0];

		if (!parent) {
			const entries: { path: string; oid: string }[] = [];
			const stack: { treeOid: string; prefix: string }[] = [
				{ treeOid: commit.commit.tree, prefix: "" },
			];

			while (stack.length) {
				const { treeOid, prefix } = stack.pop() as {
					treeOid: string;
					prefix: string;
				};
				const { tree } = await git.readTree({ ...repo, oid: treeOid });
				for (const entry of tree) {
					const full = prefix ? `${prefix}/${entry.path}` : entry.path;
					if (entry.type === "tree") {
						stack.push({ treeOid: entry.oid, prefix: full });
					} else if (entry.type === "blob") {
						entries.push({ path: full, oid: entry.oid });
					}
				}
			}

			const files: DiffFile[] = await Promise.all(
				entries.map(async ({ path, oid }) => {
					const { blob } = await git.readBlob({ ...repo, oid });
					const after = detectBlobContent(blob);
					return buildDiffFile(path, "added", null, after);
				}),
			);

			return summarizeDiff(files);
		}

		const files = await walkTreeDiff(repo, parent, commitSha);
		return summarizeDiff(files);
	} catch (error) {
		throw new Error(`Failed to get commit diff: ${error}`);
	}
}

/** The diff between two refs (base -> compare). */
export async function getDiffBetweenRefs(
	repo: Repo,
	baseRef: string,
	compareRef: string,
): Promise<DiffResult> {
	const [baseOid, compareOid] = await Promise.all([
		git.resolveRef({ ...repo, ref: qualifyBranchRef(baseRef) }),
		git.resolveRef({ ...repo, ref: qualifyBranchRef(compareRef) }),
	]);

	const files = await walkTreeDiff(repo, baseOid, compareOid);
	return summarizeDiff(files);
}
