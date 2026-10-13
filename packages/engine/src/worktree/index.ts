// Story claims (DIPO-38; 0010 sections 2, 2a and 7): the claim with its branch and locked worktree,
// the claim facts, and the load step that pins live claims' worktree snapshots. Setup of a claimed
// worktree (DIPO-39; 0010 sections 8 and 9): files, port slot, run environment and install.

export { CLAIM_NOTICES, CLAIM_STATUS, claimStory, MIN_FREE_BYTES, rollbackClaim } from "./claim";
export type {
  ClaimDeps,
  Claimed,
  ClaimOutcome,
  ClaimRequest,
  ClaimSkip,
  RollbackDeps,
  RollbackTarget,
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
  releaseClaim,
  releasedBranchFor,
  releaseReclaimedBy,
} from "./records";
export type { ClaimRecord, ReleasedBranch } from "./records";
export { buildRunEnv, RUN_ENV_NAMES, RunEnvError, substitute } from "./run-env";
export type { RunEnvInput } from "./run-env";
export { ENV_FILES_RULE, SETUP_NOTICES, setupWorktree, STEP_OUTPUT_TAIL } from "./setup";
export type {
  SetupDeps,
  SetupDone,
  SetupHost,
  SetupOutcome,
  SetupRequest,
  SetupSkip,
} from "./setup";
export { MAIN_CHECKOUT_SLOT, SLOTS_FILE, SlotTable, SlotTableError } from "./slots";
export type { SlotEntry, SlotTableOptions } from "./slots";
