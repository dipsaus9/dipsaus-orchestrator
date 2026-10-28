// Engine git (DIPO-31): hardened calls, the per-office serial queue, the `_base` worktree, and the
// one writer of commits, refs and pushes (`write.ts`, 0010).

export { EngineGit, gitSettings } from "./feature";
export type { EngineGitDeps } from "./feature";
export {
  BASE_CHECKOUT_CONFIG,
  BASE_CHECKOUT_ENV,
  DROPPED_GIT_ENV,
  DROPPED_GIT_ENV_PREFIXES,
  FETCH_CONFIG,
  HARDENED_CONFIG,
  hardenedArgs,
  hardenedCwd,
  hardenedEnv,
  isDroppedGitEnv,
  KEPT_AUTH_ENV,
  WORKTREE_ADD_CONFIG,
} from "./hardened";
export type { GitLocation } from "./hardened";
export {
  buildCommitSha,
  ENGINE_PATH,
  ENGINE_READ_TIMEOUT_MS,
  engineCommitsAfter,
  readEngineCommitsAfter,
} from "./build-commit";
export type { EngineCommitsOptions, EngineCommitsRead } from "./build-commit";
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
export { changedLinks, readWorktreeSnapshot, worktreeTampered } from "./snapshot";
export type { SnapshotLink, WorktreeSnapshot } from "./snapshot";
export {
  clockSleep,
  EXTERNAL_STEP_TIMEOUT_MS,
  GIT_STEP_DEADLINE_MS,
  GitError,
  heldLock,
  isTimedOut,
  LOCK_RETRY_DELAYS_MS,
  runGitStep,
  runGitStepOk,
  spawnGitExec,
} from "./runner";
export type { GitCall, GitExec, GitResult, GitStepOptions, GitStepRunner, Sleep } from "./runner";
export {
  abortMerge,
  commitStaged,
  commitTree,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  mergeInWorktree,
  moveBranch,
  moveRef,
  pushBranch,
  pushRef,
  remoteRefMissing,
  remoteUrl,
  resetWorktree,
  statusPaths,
} from "./write";
export type { CommitMessage, PushResult, RemoteDelete } from "./write";
export {
  checkGitVersion,
  isSupportedGitVersion,
  MIN_GIT_VERSION,
  parseGitVersion,
} from "./version";
export type { GitVersion } from "./version";
