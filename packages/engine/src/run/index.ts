// Runs (DIPO-48): `work.run` picks and claims one Ready story and records the run; the run facts
// and the pickup order are in records/. The worker start of a claimed run and the dry run
// `work.preview` (DIPO-74).

export {
  storyRunBase,
  DEVELOPER_ROLE,
  REFINED_STATUS,
  RUN_NOTICES,
  RUN_REFUSED,
  RUNS_CHECK,
  WorkRun,
} from "./work-run";
export type { BaseRead, RunBase, RunLane, RunOffices, WorkRunDeps } from "./work-run";
export {
  LAUNCH_NOTICES,
  packageCacheSkippedText,
  planRefusedText,
  PREVIEW_RUN,
  capsOf,
  RunLauncher,
  runLaunchPaths,
  runWorkerSpec,
  START_FAILED_RELEASE,
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
export { SESSION_FOLDER_PREFIX, SessionRuns } from "./session-run";
export type { SessionRunsDeps } from "./session-run";
export { renderRunPrompts, sessionUuid, SYSTEM_FILE } from "./prompts";
export type { RunPrompts, RunPromptsInput } from "./prompts";
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
  FIX_LIFT_TRIES,
  FIX_ROUNDS_RECOVERY_STEP,
  FIX_NOTICES,
  FixRounds,
  fixRoundQueued,
  HELD_TEST_KEY,
  heldTestNotes,
  holdTestNote,
  lastReviewVerdict,
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
} from "./review-rounds";
export type { ReviewRound } from "./review-rounds";
export {
  gitReviewOps,
  parseNumstat,
  REVIEW_COMMIT_PREFIX,
  reviewCommitFile,
  ReviewLauncher,
  reviewerSettings,
  snapshotReviewCaps,
  sweepOldReviewFolders,
} from "./review-launch";
export type {
  ReviewGit,
  ReviewLauncherDeps,
  ReviewSessionOutcome,
  ReviewSessionRequest,
  ReviewSessions,
} from "./review-launch";
export {
  blockingDetail,
  REVIEW_CRASHED_END,
  REVIEW_NOTICES,
  REVIEW_TAGS,
  reviewerView,
  Reviews,
} from "./reviews";
export type { ReviewsDeps } from "./reviews";
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
  HOST_CONNECT_TIMEOUT_MS,
  HOST_LAUNCH_DEADLINE_MS,
  hostLaunchDeadline,
  hostRequestOf,
  hostSocketSteering,
  OfficeIngest,
  STEER_TIMEOUT_MS,
  systemHostStarter,
} from "./hosts";
export type { OfficeIngestOptions, OfficeRunListener, SystemHostStarterOptions } from "./hosts";
export { Watchdog, WATCHDOG_DEFAULTS } from "./watchdog";
export type { WatchdogOptions, WatchdogTimeouts } from "./watchdog";
// Caps, parks and `story.park` of a story with a run (DIPO-50).
export {
  CAP_TICK_MS,
  CONTROL_NOTICES,
  DAEMON_STOPPED_DETAIL,
  EVENT_FILE_CHANGED,
  RunControl,
  STOP_ALL_EXIT_WAIT_MS,
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
  gitParkWriter,
  gitUnparkWriter,
  openPark,
  PARK_NOTICES,
  parkActions,
  parkStory,
} from "./park";
export type {
  BranchPark,
  ParkBranchRequest,
  ParkDeps,
  ParkOutcome,
  ParkRequest,
  ParkWriter,
  BranchUnpark,
  ParkBranchFacts,
  UnparkBranchRequest,
  UnparkWriter,
} from "./park";
// In Review at a box run's done and run outcomes (DIPO-49, DIPO-240).
export { gitStoryOps, IN_REVIEW_STATUS } from "./story-git";
export type { BranchStory, PushResult, StoryGit } from "./story-git";
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
// Worker outcomes and the run's next session (DIPO-51).
export {
  INIT_REJECTED_SIGKILL_AFTER_MS,
  initRejectedEnding,
  HOST_LOST_END,
  HOST_LOST_WHY,
  INTENT_TAGS,
  intentTag,
  planLimitEnding,
  OUTCOME_NOTICES,
  REASSIGN_SIGTERM_AFTER_MS,
  reportFeedbackText,
  REDISPATCH_STEP,
  RunOutcomes,
  storyHoldsWork,
} from "./outcomes";
export type {
  ExitContext,
  RunAct,
  RunEnder,
  RunOutcomesDeps,
  RunOutcomesPort,
  PlanLimitHit,
  PlanLimitPauses,
  StartsPausedPort,
  RunView,
} from "./outcomes";
// The office's starts paused: a plan limit or a failed adapter check (0020, DIPO-359).
export {
  LIFT_COMMAND,
  officeHoldStore,
  PLAN_LIMIT_RESUME_AFTER_MS,
  PLAN_LIMIT_UNKNOWN_RESET_MS,
  planLimitPause,
  STARTS_PAUSED_NOTICES,
  STARTS_PAUSED_RETRY_MS,
  STARTS_PAUSED_STEP,
  StartsPaused,
  startsPausedRefusal,
} from "./starts-paused";
export type {
  HoldStoreOffices,
  LiftedPark,
  LiftedResume,
  PlanLimitPause,
  StartsPausedDeps,
  StartsPausedReason,
  StartsPausedState,
} from "./starts-paused";
// `story.park` of a story with no run and `story.drop` through the planning lane (DIPO-160), and
// the resume of such a park that `work.resume` hands them.
export {
  HAS_DEPENDENTS,
  NOT_DROPPABLE,
  NOT_PARKABLE,
  PLANNING_NOTICES,
  PR_NOT_CLOSED,
  STORY_ACTIVE,
  StoryPlanning,
} from "./planning";
export type { StoryPlanningDeps } from "./planning";
// `work.discard` (DIPO-161): a story's work thrown away through the backlog lane.
export { DISCARD_NOTICES, NOT_DISCARDABLE, PR_MERGED, StoryDiscard } from "./discard";
export type { DiscardStop, StoryDiscardDeps } from "./discard";
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
// Park resume and `work.resume` in one module (DIPO-138).
export { createRunOutcomes, NOT_PARKED, Resumption, RUN_HOST_ALIVE } from "./resumption";
export type { ResumptionOptions } from "./resumption";
// The resume of every parked story by the 0020 table (DIPO-155, DIPO-344).
export { MAINTAINER_RESUME_TAG, PARK_RESUME_NOTICES, RESUME_ERRORS } from "./park-resume";
export { share, smallestShare, withGrants } from "./resume-caps";
export { noteText } from "./resume";
export type {
  ConflictPrepared,
  ConflictResumer,
  ParkResumeOptions,
  PrReplacement,
  MergeReentry,
} from "./park-resume";
export { resolvePark, type ParkResolution } from "./park";
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
// Re-attach after a daemon restart (DIPO-57).
export {
  EXIT_CHECK_MS,
  HOST_NEVER_STARTED,
  hostStoppedDetail,
  macSessionText,
  REATTACH_NOTICES,
  REATTACH_STEP,
  RunReattacher,
} from "./reattach";
export type { ReattachedRun, ReattachOutcome, RunReattacherDeps } from "./reattach";
export { dueNotices, USAGE_NOTICES, UsageAlerts } from "./usage-alerts";
export type { DueNotice, UsageAlertsDeps } from "./usage-alerts";
// Testing a story (DIPO-309): `test.start`, `test.record`, the sweep and the records.
export {
  manualSteps,
  profileRefusal,
  StoryTests,
  TEST_BOX_DIR,
  TEST_RECOVERY_STEP,
  TESTABLE_PHASES,
  testableRun,
  testBoxScripts,
} from "./tests";
export type { StoryTestsDeps, TestBoxPort } from "./tests";
export {
  endTest,
  findTest,
  latestRecordedTest,
  openTestOf,
  openTests,
  openTestViews,
  recordTestResult,
  TEST_RECORDED,
  shellLine,
  TEST_GATE_KIND,
  testPassedFor,
  testViewOf,
} from "./test-records";
export type { StoredTest } from "./test-records";
