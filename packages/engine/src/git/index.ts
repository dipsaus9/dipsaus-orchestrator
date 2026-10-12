// Engine git (DIPO-31): hardened calls, the per-office serial queue and the `_base` worktree.

export { EngineGit, gitSettings } from "./feature";
export type { EngineGitDeps } from "./feature";
export {
  DROPPED_GIT_ENV,
  HARDENED_CONFIG,
  hardenedArgs,
  hardenedCwd,
  hardenedEnv,
} from "./hardened";
export type { GitLocation } from "./hardened";
export { OfficeGit } from "./office";
export type {
  BaseWorktree,
  FetchOutcome,
  FetchState,
  GitSession,
  GitSettings,
  OfficeGitOptions,
} from "./office";
export {
  BASE_WORKTREE,
  canonicalFuturePath,
  DEFAULT_WORKTREE_ROOT,
  isInside,
  resolveWorktreeRoot,
} from "./paths";
export { GitQueue } from "./queue";
export {
  clockSleep,
  GitError,
  heldLock,
  LOCK_RETRY_DELAYS_MS,
  runGitStep,
  runGitStepOk,
  spawnGitExec,
} from "./runner";
export type { GitCall, GitExec, GitResult, GitStepRunner, Sleep } from "./runner";
export {
  checkGitVersion,
  isSupportedGitVersion,
  MIN_GIT_VERSION,
  parseGitVersion,
} from "./version";
export type { GitVersion } from "./version";
