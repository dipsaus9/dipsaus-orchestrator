// Runs (DIPO-48): `work.run` picks and claims one Ready story and records the run; the run facts
// and the pickup order. The worker start of a claimed run and the dry run `work.preview` (DIPO-74).

export {
  cliRunBase,
  DEVELOPER_ROLE,
  PLAN_LIMIT_CHECK,
  REFINED_STATUS,
  RUN_NOTICES,
  RUN_REFUSED,
  RUNS_CHECK,
  WorkRun,
} from "./work-run";
export type { BaseRead, RunBase, RunLane, RunOffices, WorkRunDeps } from "./work-run";
export {
  DEVELOPER_TOOLS,
  LAUNCH_NOTICES,
  planRefusedText,
  PREVIEW_RUN,
  capsOf,
  RunLauncher,
  runLaunchPaths,
  runWorkerSpec,
  START_FAILED_END,
  systemHashOf,
} from "./launch";
export type {
  HostStarter,
  PreparedRun,
  RunFacts,
  RunIngest,
  RunLauncherDeps,
  StartOutcome,
  TierCaps,
} from "./launch";
export { renderRunPrompts, sessionUuid, SYSTEM_FILE } from "./prompts";
export type { RunPrompts, RunPromptsInput } from "./prompts";
export {
  activeRuns,
  capsStartedAt,
  appendRunStep,
  currentProfileId,
  endRun,
  IN_REVIEW_END,
  PARKED_OUTCOME,
  recordGateChanges,
  runOutcome,
  findRun,
  hasActiveRun,
  insertRun,
  recordConfigSnapshot,
  runSteps,
} from "./records";
export type { NewRun, RunKind, RunOutcome, StoredRun, StoredRunStep, RunStepKind } from "./records";
export { openDependencies, pickupOrder, priorityRank, READY_STATUS, statusSkip } from "./select";
export {
  followOnlyReason,
  HOST_CONNECT_TIMEOUT_MS,
  hostRequestOf,
  hostSocketSteering,
  OfficeIngest,
  STEER_TIMEOUT_MS,
  systemHostStarter,
} from "./hosts";
export type { OfficeIngestOptions, OfficeRunListener, SystemHostStarterOptions } from "./hosts";
export { Watchdog, WATCHDOG_DEFAULTS } from "./watchdog";
export type { WatchdogOptions, WatchdogTimeouts } from "./watchdog";
export { activeSignals, clearSignals, LIVENESS_SIGNALS, raiseSignal } from "./signals";
export type { StoredSignal } from "./signals";
// Caps, parks and `work.stop` (DIPO-50).
export {
  CAP_TICK_MS,
  CONTROL_NOTICES,
  EVENT_FILE_CHANGED,
  INTERRUPTED_END,
  RECONCILED_END,
  RunControl,
  STOPPED_DETAIL,
  STORY_NOT_RUNNING,
} from "./control";
export type {
  ReconcileNotice,
  RunControlDeps,
  RunEnding,
  RunSteering,
  TrackedRun,
} from "./control";
export { firedCap, runTotals } from "./caps";
export type { CapName, FiredCap, RunTotals } from "./caps";
export {
  markIntentSent,
  outcomeOfIntent,
  recordIntent,
  resolveIntent,
  runIntents,
} from "./intents";
export type { IntentKind, IntentState, StoredIntent } from "./intents";
export {
  gitParkWriter,
  gitUnparkWriter,
  openPark,
  PARK_NOTICES,
  parkActions,
  parkStory,
  WORKTREE_TAMPERED,
} from "./park";
export type {
  BranchPark,
  ParkBranchRequest,
  ParkDeps,
  ParkOutcome,
  ParkRequest,
  ParkWriter,
  BranchUnpark,
  UnparkBranchRequest,
  UnparkWriter,
} from "./park";
// Verify and commit at In Review, the backstop after every turn and run outcomes (DIPO-49).
export { backstopDetail, backstopEvidence, readBackstop } from "./backstop";
export type { BackstopSnapshot } from "./backstop";
export { gitStoryOps, IN_REVIEW_STATUS } from "./story-git";
export type { PushResult, StoryGit, WorktreeStory } from "./story-git";
export {
  checkScope,
  commitMessage,
  DEFAULT_LOCKFILES,
  feedbackItemMax,
  GATE_CAPABILITIES,
  gateChanges,
  OUTPUT_FLUSH_MS,
  scanWorktree,
  scopeCovers,
  scopeDetail,
  VERIFY_NOTICES,
  VerifyCommit,
  verifyPlan,
  workspaceDirsOf,
} from "./verify-commit";
export type {
  RunFinisher,
  ScopeInput,
  ScopeResult,
  TurnContext,
  TurnDecision,
  VerifyCommitDeps,
  VerifyStep,
} from "./verify-commit";
export {
  appendVerifyOutput,
  insertVerifyResult,
  outputTail,
  recordCodeTreeKey,
  runSummary,
  storeRunSummary,
  SUMMARY_OUTPUT_LINES,
  verifyOutputEnd,
  verifyResults,
} from "./verify-records";
export type {
  NewVerifyResult,
  RunSummary,
  StoredVerifyResult,
  VerifyProfile,
} from "./verify-records";
// Worker outcomes and the run's next session (DIPO-51).
export {
  INIT_REJECTED_SIGKILL_AFTER_MS,
  initRejectedEnding,
  HOST_LOST_END,
  HOST_LOST_WHY,
  INTENT_TAGS,
  intentTag,
  openWait,
  OUTCOME_ENDS,
  PLAN_LIMIT_CONTINUE,
  OUTCOME_NOTICES,
  REASSIGN_SIGTERM_AFTER_MS,
  reportFeedbackText,
  REDISPATCH_STEP,
  RunOutcomes,
  storyHoldsWork,
} from "./outcomes";
export type {
  ExitContext,
  HostLostContext,
  RunAct,
  RunEnder,
  RunOutcomesDeps,
  RunOutcomesPort,
  ResumeParkOutcome,
  ResumeParkRequest,
  PlanLimitHit,
  PlanLimitWaits,
  PlanLimitWarning,
  RunView,
  WaitFact,
  WaitScope,
} from "./outcomes";
// Waiting for plan-limit resets and `work.resume` of held runs (DIPO-61).
export {
  inFamily,
  NOT_PAUSED_OR_PARKED,
  PLAN_LIMIT_NOTICES,
  PLAN_LIMIT_PROBE_MS,
  PLAN_LIMIT_RESUME_AFTER_MS,
  PLAN_LIMIT_RETRY_MS,
  PLAN_LIMIT_STEP,
  PlanLimits,
  RUN_HOST_ALIVE,
  scopeHolds,
  wakeAt,
} from "./plan-limit";
export type { PlanLimitsDeps, ResumeWaitOutcome } from "./plan-limit";
export {
  baseStoryFacts,
  HOST_EXIT_WAIT_MS,
  RESUME_NOTICES,
  RESUME_POLICY,
  RunResumer,
} from "./resume";
export type {
  NextSession,
  NextSessionOutcome,
  NextSessionRequest,
  RunResumerDeps,
  RunStoryFacts,
} from "./resume";
// Re-attach after a daemon restart (DIPO-57).
export { FOLLOW_CHECK_MS, REATTACH_NOTICES, REATTACH_STEP, RunReattacher } from "./reattach";
export type { ReattachedRun, ReattachOutcome, RunReattacherDeps } from "./reattach";
