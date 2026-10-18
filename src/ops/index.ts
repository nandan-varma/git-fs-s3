export {
	assertBranchExists,
	assertSafeBranchName,
	type Branch,
	createBranchFrom,
	deleteBranchByName,
	listBranches,
	resolveLooseRefFast,
} from "./branch.js";
export {
	authorNow,
	type CommitAuthor,
	commitFilesToBare,
	deleteFileFromBare,
	writeCommitToBare,
} from "./commit.js";
export {
	type DiffFile,
	type DiffResult,
	getCommitDiff,
	getDiffBetweenRefs,
	MAX_DIFF_TEXT_BYTES,
} from "./diff.js";
export {
	BANNER_WALK_DEPTH,
	type FileHistoryResult,
	getFileHistory,
} from "./file-history.js";
export {
	type CommitInfo,
	type CommitLogOptions,
	type CommitSummary,
	type GitIdentity,
	getBlob,
	getCommit,
	getCommitHistory,
	getCommitLog,
	getFileContent,
	getTreeFromRef,
	HISTORY_WALK_DEPTH,
	resolveCommit,
	summarizeCommit,
} from "./history.js";
export { getLastCommitsForTree } from "./last-commit.js";
export { analyzeMerge, fastForwardMerge, type MergeAnalysis } from "./merge.js";
export { withPackedWrites } from "./packed-writes.js";
export {
	deleteFromTree,
	findTreeEntry,
	listTreeEntries,
	type TreeEntry,
	upsertTree,
} from "./tree.js";
export {
	type IsoGitFs,
	type OpsHooks,
	type Repo,
	type ResultCache,
	resultKeyPrefixes,
} from "./types.js";
