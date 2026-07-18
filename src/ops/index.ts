export {
	assertBranchExists,
	assertSafeBranchName,
	type Branch,
	createBranchFrom,
	deleteBranchByName,
	listBranches,
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
} from "./diff.js";
export {
	BANNER_WALK_DEPTH,
	type FileHistoryEntry,
	type FileHistoryResult,
	getFileHistory,
	HISTORY_WALK_DEPTH,
} from "./file-history.js";
export {
	type CommitInfo,
	type CommitLogOptions,
	getBlob,
	getCommit,
	getCommitHistory,
	getCommitLog,
	getFileContent,
	getFileFromRef,
	getTreeFromRef,
	resolveCommit,
} from "./history.js";
export {
	getLastCommitsForTree,
	type LastCommitInfo,
} from "./last-commit.js";
export { analyzeMerge, fastForwardMerge, type MergeAnalysis } from "./merge.js";
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
