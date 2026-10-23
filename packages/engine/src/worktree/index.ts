// Story claims (DIPO-38; 0010 sections 2, 2a and 7): the claim with its branch and locked worktree,
// the claim facts, and the load step that pins live claims' worktree snapshots. Setup of a claimed
// worktree (DIPO-39; 0010 sections 8 and 9): files, port slot, run environment and install.
// Done detection and teardown (DIPO-58; 0010 section 7): the Done poll, worktree and branch removal.

export { CLAIM_NOTICES, CLAIM_STATUS, claimStory, MIN_FREE_BYTES } from "./claim";
export type {
  ClaimDeps,
  Claimed,
  ClaimOutcome,
  ClaimRequest,
  ClaimSetupDone,
  ClaimSetupFailed,
  ClaimSkip,
} from "./claim";
export { CLAIMS_STEP, StoryClaims } from "./feature";
export type { StoryClaimsDeps } from "./feature";
export { FileStepError, isEnvFileName, placeFiles, repoSegments } from "./files";
export type { FileStepInput, FileStepResult, SettingsCopy, WorktreeFileSpec } from "./files";
export {
  FAILED_CLAIM_REASONS,
  findClaim,
  hasLiveClaim,
  keysTrackingBranch,
  liveClaimOf,
  liveClaims,
  openReleasedBranches,
  releaseClaim,
  releasedBranchFor,
} from "./records";
export type { ClaimRecord, ReleasedBranch } from "./records";
export { buildRunEnv, RUN_ENV_NAMES, RunEnvError, substitute } from "./run-env";
export type { RunEnvInput } from "./run-env";
export {
  baseVerifyConfigHash,
  baseVerifyFactsOf,
  failingTests,
  findBaseVerify,
  storeBaseVerify,
} from "./base-verify";
export { ENV_FILES_RULE, SETUP_NOTICES, setupWorktree } from "./setup";
export type { SetupDeps, SetupDone, SetupOutcome, SetupRequest } from "./setup";
export { MAIN_CHECKOUT_SLOT, SLOTS_FILE, SlotTable, SlotTableError } from "./slots";
export type { SlotEntry, SlotTableOptions } from "./slots";
export { SWEEP_MARGIN_MS, sweepBranchReads } from "./sweep";
export type { BranchReadSweep } from "./sweep";
export {
  DISCARD_RELEASE_REASON,
  DROP_RELEASE_REASON,
  deleteKeptBranches,
  deleteOwnBranch,
  dirtyFilesOf,
  releaseForDiscard,
  releaseForDrop,
  removeLeftovers,
  repoOfPrUrl,
} from "./release";
export type { DiscardBranchOutcome, DropReleaseDeps, DropReleaseOutcome } from "./release";
// A story finished outside dipo (DIPO-161): the release, its leftovers and their desk items.
export {
  DONE_ELSEWHERE_DESK,
  DONE_ELSEWHERE_NOTICES,
  DONE_ELSEWHERE_REASON,
  doneElsewhereDeskItems,
  findDoneElsewhere,
  openLeftovers,
} from "./done-elsewhere";
export type {
  DoneElsewhereDeps,
  DoneElsewhereDeskItem,
  DoneElsewhereRecord,
} from "./done-elsewhere";
export { PARKED_STATUS, StoryTeardown, TEARDOWN_STEP } from "./done";
export type { PollReport, StoryTeardownDeps } from "./done";
export {
  claimLockReason,
  detectDone,
  DONE_RELEASE_REASON,
  lockInList,
  tearDown,
  TEARDOWN_NOTICES,
} from "./teardown";
export type {
  DetectDeps,
  DoneCheck,
  DoneEvidence,
  DoneProblem,
  TeardownDeps,
  TeardownOutcome,
} from "./teardown";
