// Merging story and backlog PRs with GitHub's auto-merge, the merge gates in front of a story PR's
// auto-merge, and the close-out commit (0002, 0010).

export { AUTO_MERGE_FAILED, AUTO_MERGE_STEP, AutoMerge } from "./merger";
export type { AutoMergeDeps } from "./merger";
export { BACKLOG_MERGE_NOTICES, BacklogMerges } from "./backlog";
export type { BacklogMergeContext, BacklogMergeDeps } from "./backlog";
export { laneMergeGit } from "./backlog-git";
export type { BacklogMergeGit } from "./backlog-git";
export { STORY_MERGE_NOTICES, StoryMerges } from "./stories";
export type { StoryMergeContext, StoryMergeDeps } from "./stories";
export { gitStoryMergeOps, MODIFIED_FILES_MAX } from "./story-git";
export type { ConflictMerge, PushOutcome, StoryMergeGit, StoryMergeRun } from "./story-git";
export { closeOutFields, DONE_STATUS, writeCloseOutSummary } from "./close-out";
export { MergeGates } from "./commands";
export type { MergeGatesDeps } from "./commands";
export {
  AUTORELEASE_LABEL,
  autoreleasePending,
  decideMergeGate,
  decideOnHandMerge,
  HAND_MERGE_NOTE,
  holdLabelsOn,
  MERGE_GATE_KIND,
  mergeGate,
  mergeGatesOfRun,
  mergeGateSummary,
  mergeWaits,
  openMaintainerMergeGate,
  openMergeGate,
  overrideGateOf,
  overrideGateSummary,
  RELEASE_PATH_HOLD,
  releasePathList,
} from "./gates";
export type { HandMerge, MergeWait, StoredMergeGate } from "./gates";
// The release path of a story PR: the paths the base CODEOWNERS gives an owner.
export { CODEOWNERS_LOCATIONS, parseCodeowners, releasePathsOf } from "./release-path";
export type { CodeownersRule } from "./release-path";
