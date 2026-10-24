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
  packageCacheSkippedText,
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
export { SESSION_ENDS, SESSION_FOLDER_PREFIX, SessionRuns } from "./session-run";
export type { SessionRunsDeps } from "./session-run";
export { renderRunPrompts, sessionUuid, SYSTEM_FILE } from "./prompts";
export type { RunPrompts, RunPromptsInput } from "./prompts";
export {
  activeRuns,
  backstopSnapshotOf,
  capsStartedAt,
  appendRunStep,
  currentProfileId,
  DONE_END,
  endRun,
  finishRun,
  IN_REVIEW_END,
  PARKED_OUTCOME,
  recordGateChanges,
  reopenRun,
  runOutcome,
  runRoundCounts,
  findRun,
  hasActiveRun,
  insertRun,
  recordConfigSnapshot,
  storeBackstopSnapshot,
  runSteps,
} from "./records";
export type {
  NewRun,
  RunKind,
  RunOutcome,
  RunRounds,
  StoredRun,
  StoredRunStep,
  RunStepKind,
} from "./records";
// The office's worker and reviewer places and the run across review rounds (DIPO-142).
export {
  claimPlace,
  DEFAULT_REVIEW_MODEL,
  pausedPlaces,
  PLACE_NOTICES,
  PLACE_TICK_MS,
  placeHolders,
  placeOfRole,
  placeOfRun,
  placeOfStart,
  Places,
  PLACES,
  PLACES_STEP,
  placeTaken,
  START_KINDS,
  startOrder,
  waitForPlace,
  waitingStarts,
} from "./places";
export type { Place, PlacesDeps, PlaceStart, PlaceStarter, StartKind } from "./places";
export { endReviewPeriod, reopenForRound, REVIEWED_END } from "./rounds";
export type { RoundKind } from "./rounds";
export {
  feedbackItems,
  feedbackOfIntent,
  markFeedbackSent,
  nextFixRound,
  planFeedback,
  sameFailureAgain,
  storeFeedbackItems,
} from "./feedback-items";
export type { PlannedItem, StoredFeedbackItem } from "./feedback-items";
export {
  deliverFixRound,
  FIX_LIFT_TRIES,
  FIX_ROUNDS_RECOVERY_STEP,
  FIX_NOTICES,
  FIX_ROUND_TAG,
  FixRounds,
  fixRoundQueued,
  lastReviewVerdict,
  pendingFixRound,
} from "./fix-rounds";
export type { FixRoundsDeps, FixSessions } from "./fix-rounds";
export {
  approvalCarries,
  baseConflictOf,
  blockedHandOff,
  CONFLICT_CAP_DEFAULT,
  CONFLICT_NOTICES,
  catchUpsOf,
  ConflictResumes,
  handOffState,
  inReviewRunIds,
  markBoxCopied,
  pendingBoxCopy,
  recordCatchUp,
  recordedConflictPaths,
  StoryConflicts,
} from "./conflicts";
export type {
  ConflictResumesDeps,
  DoneConflictDecision,
  StoredCatchUp,
  StoryConflictsDeps,
} from "./conflicts";
export {
  beginReviewRound,
  failedReviewRounds,
  openReviewRound,
  pendingReviews,
  reviewRounds,
  takeVerdict,
  verifiedTreeKey,
} from "./review-rounds";
export type { ReviewRound } from "./review-rounds";
export {
  checkCopyComplete,
  gitReviewOps,
  makeReviewCopy,
  parseNumstat,
  removeReviewFolder,
  REVIEW_COMMIT_FILE,
  ReviewCopyMismatchError,
  REVIEW_FOLDER_PREFIX,
  REVIEW_SESSION_DIR,
  reviewFolder,
  ReviewLauncher,
  reviewerSettings,
  snapshotReviewCaps,
  sweepReviewFolders,
} from "./review-launch";
export type {
  ReviewCopy,
  ReviewGit,
  ReviewLauncherDeps,
  ReviewSessionOutcome,
  ReviewSessionRequest,
  ReviewSessions,
} from "./review-launch";
export {
  blockingDetail,
  REVIEW_BLOCKED_END,
  REVIEW_CRASHED_END,
  REVIEW_NOTICES,
  REVIEW_TAGS,
  reviewerView,
  Reviews,
} from "./reviews";
export type { ReviewsDeps } from "./reviews";
export { openDependencies, pickupOrder, priorityRank, READY_STATUS, statusSkip } from "./select";
export {
  afterRunExits,
  isRunTempDir,
  prepareRunTempDir,
  readRunTempOwner,
  removeRunTempDir,
  RUN_TEMP_OWNER_FILE,
  RUN_TEMP_PREFIX,
  RUN_TEMP_SWEEP_STEP,
  RunTempDirs,
  runTempDir,
  runTempOwner,
} from "./temp-dirs";
export type { RunTempDirsDeps, RunTempSweep } from "./temp-dirs";
export {
  followOnlyReason,
  HOST_CONNECT_TIMEOUT_MS,
  hostRequestOf,
  hostSocketSteering,
  isStopSequence,
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
  DAEMON_STOPPED_DETAIL,
  EVENT_FILE_CHANGED,
  INTERRUPTED_END,
  RECONCILED_END,
  RunControl,
  STOP_ALL_EXIT_WAIT_MS,
  STOPPED_DETAIL,
  STORY_NOT_RUNNING,
} from "./control";
export type {
  ReconcileNotice,
  RunControlDeps,
  RunEnding,
  RunSteering,
  StopAllResult,
  TrackedRun,
} from "./control";
export {
  firedCap,
  REVIEWER_ROLE,
  runCaps,
  runTotals,
  STREAM_DRIFT_LINES,
  streamDriftDetail,
} from "./caps";
export type { CapName, FiredCap, RunCaps, RunTotals, StreamDriftFacts } from "./caps";
export { preStartEnding, reachedCaps } from "./pre-start-caps";
export { GRANT_KINDS, grantTotals, recordGrant } from "./grants";
export type {
  BudgetGrant,
  CountedGrantKind,
  GrantAmount,
  GrantKind,
  GrantTotals,
  NewGrant,
  ReviewCapGrant,
} from "./grants";
export {
  markIntentSent,
  outcomeOfIntent,
  recordIntent,
  resolveIntent,
  runIntents,
  sendAsIntent,
} from "./intents";
export type { IntentKind, IntentState, IntentSteering, StoredIntent } from "./intents";
export {
  gitParkWriter,
  gitUnparkWriter,
  openPark,
  PARK_CAUSES,
  PARK_NOTICES,
  parkActions,
  parkStory,
  WORKTREE_TAMPERED,
} from "./park";
export type {
  BranchPark,
  ParkBranchRequest,
  ParkCause,
  ParkDeps,
  ParkOutcome,
  ParkRequest,
  ParkWriter,
  BranchUnpark,
  ParkBranchFacts,
  UnparkBranchRequest,
  UnparkWriter,
} from "./park";
// The structured summary on park, resume and close, and a handoff's open feedback (DIPO-154).
export {
  finalSummaryFacts,
  finalSummaryOf,
  grantText,
  oneLine,
  renderFinalSummary,
  renderParkBlock,
  resumeLine,
  runSummaryFacts,
  summaryDate,
} from "./summary";
export type { FinalSummaryFacts, ParkBlockFacts, ResumeLineFacts } from "./summary";
export {
  ANSWERED_BY,
  answered,
  openFeedbackOf,
  runAnswers,
  storedFeedbackOf,
} from "./open-feedback";
export type { AnswerKind, RunAnswers, StoredFeedback } from "./open-feedback";
// In Review at a box run's done, the reviewer's backstop and run outcomes (DIPO-49, DIPO-240).
export { backstopDetail, backstopEvidence, readBackstop } from "./backstop";
export type { BackstopSnapshot } from "./backstop";
export { gitStoryOps, IN_REVIEW_STATUS } from "./story-git";
export type { PushResult, StoryGit, WorktreeStory } from "./story-git";
export {
  BOX_TIP_MOVED,
  DEFAULT_LOCKFILES,
  dependenciesChangedText,
  DEPENDENCY_FILES,
  dependencyFiles,
  GATE_CAPABILITIES,
  gateChanges,
  NO_BOX_AT_DONE,
  scopeCovers,
  VERIFY_NOTICES,
  VerifyCommit,
} from "./verify-commit";
export type { RunFinisher, TurnContext, TurnDecision, VerifyCommitDeps } from "./verify-commit";
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
  PLAN_LIMIT_NOTICES,
  PLAN_LIMIT_PROBE_MS,
  PLAN_LIMIT_RESUME_AFTER_MS,
  PLAN_LIMIT_RETRY_MS,
  PLAN_LIMIT_STEP,
  PlanLimits,
  scopeHolds,
  wakeAt,
} from "./plan-limit";
export type { PlanLimitsDeps } from "./plan-limit";
export {
  allowanceInForce,
  allowanceLifts,
  CLEAR_ALLOWANCE_CLI,
  LIMITS_NO_WARNING,
  type LimitHold,
  type StoredAllowance,
} from "./plan-allowance";
// `story.hold` and `story.drop` through the planning lane (DIPO-160), and the on-hold resume that
// `work.resume` hands them.
export {
  DIRTY_WORKTREE,
  HAS_DEPENDENTS,
  NOT_DROPPABLE,
  NOT_HOLDABLE,
  PLANNING_NOTICES,
  PR_NOT_CLOSED,
  STORY_ACTIVE,
  StoryPlanning,
} from "../stories/planning";
export type { StoryPlanningDeps } from "../stories/planning";
// `work.discard` (DIPO-161): a story's work thrown away through the backlog lane.
export {
  DISCARD_NOTICES,
  DISCARDABLE_STATUSES,
  discardOp,
  NOT_DISCARDABLE,
  PR_MERGED,
  StoryDiscard,
} from "../stories/discard";
export type { DiscardStop, StoryDiscardDeps } from "../stories/discard";
// `proposal.accept` and `proposal.dismiss` (DIPO-166): a worker's proposal filed as a Backlog draft
// through the planning lane, or dismissed.
export {
  DRAFT_CAPS,
  PROPOSAL_AMBIGUOUS,
  PROPOSAL_NOT_OPEN,
  PROPOSAL_UNKNOWN,
  ProposalCommands,
  proposalDraft,
  resolveProposal,
  workerWords,
} from "./proposals";
export type { ProposalCommandsDeps, StoredProposal } from "./proposals";
export type { HoldResumer } from "./work-resume";
// Park resume and `work.resume` in one module with a per-reason policy table (DIPO-138).
export {
  createRunOutcomes,
  NOT_PAUSED_OR_PARKED,
  PARK_RESUME_POLICY,
  Resumption,
  resumeVia,
  RUN_HOST_ALIVE,
} from "./resumption";
export type {
  HeldRunResumer,
  ResumePolicyRow,
  ResumeVia,
  ResumeWaitOutcome,
  ResumptionOptions,
} from "./resumption";
// The resume of every parked story by the 0020 matrix (DIPO-155).
export { MAINTAINER_RESUME_TAG, PARK_RESUME_NOTICES, RESUME_ERRORS } from "./park-resume";
export { HALF_SHARE, share, smallestShare, withGrants } from "./resume-caps";
export { noteText } from "./resume";
export type {
  ConflictPrepared,
  ConflictResumer,
  ParkResumeOptions,
  PrReplacement,
  SlotReentry,
} from "./park-resume";
export { PARK_RESUME_MATRIX, parkResumeRow } from "./resume-policy";
export type { ParkMatrixRow, ParkResumeRow, ResumeSession } from "./resume-policy";
export { resolveParkResumed, resumableByCommand } from "./park";
export {
  baseStoryFacts,
  HOST_EXIT_WAIT_MS,
  RESUME_NOTICES,
  RESUME_POLICY,
  RunResumer,
  startTierOf,
} from "./resume";
export type {
  NextSession,
  NextSessionOutcome,
  NextSessionRequest,
  HandoffExtra,
  RunResumerDeps,
  RunStoryFacts,
} from "./resume";
// The one wiring of the run services, for the daemon and the tests (DIPO-129).
export { composeRuns, fetchAddressesOf } from "./compose";
export type { ComposedRuns, RunPorts } from "./compose";
// Re-attach after a daemon restart (DIPO-57).
export {
  FOLLOW_CHECK_MS,
  HOST_NEVER_STARTED,
  macSessionText,
  REATTACH_NOTICES,
  REATTACH_STEP,
  RunReattacher,
  STOP_AGAIN_DETAIL,
} from "./reattach";
export type { ReattachedRun, ReattachOutcome, RunReattacherDeps } from "./reattach";
export { dueNotices, USAGE_NOTICES, UsageAlerts } from "./usage-alerts";
export type { DueNotice, UsageAlertsDeps } from "./usage-alerts";
