// Merging story and backlog PRs with GitHub's auto-merge and the close-out commit (0002, 0010). The
// merge gates in front of a story PR's auto-merge are in run-state/.

export { AUTO_MERGE_FAILED, AUTO_MERGE_STEP, AutoMerge } from "./merger";
export type { AutoMergeDeps, BacklogAutoMerge, BacklogRoundContext } from "./merger";
export { STORY_MERGE_NOTICES, StoryMerges } from "./stories";
export type { StoryMergeContext, StoryMergeDeps } from "./stories";
export { gitStoryMergeOps, MODIFIED_FILES_MAX } from "./story-git";
export type { ConflictMerge, PushOutcome, StoryMergeGit, StoryMergeRun } from "./story-git";
export { closeOutFields, DONE_STATUS, writeCloseOutSummary } from "./close-out";
export { MergeGates } from "./commands";
export { guardedParkWriter, guardedUnparkWriter } from "./guard";
export type { AutoMergeGuard } from "./guard";
export type { MergeGatesDeps } from "./commands";
// The release path of a story PR: the paths the base CODEOWNERS gives an owner.
export { CODEOWNERS_LOCATIONS, parseCodeowners, releasePathsOf } from "./release-path";
export type { CodeownersRule } from "./release-path";
