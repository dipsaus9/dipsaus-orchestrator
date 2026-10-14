// Runs (DIPO-48): `work.run` picks and claims one Ready story and records the run; the run facts
// and the pickup order. The worker start of a claimed run and the dry run `work.preview` (DIPO-74).

export {
  cliRunBase,
  DEVELOPER_ROLE,
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
  RunLauncher,
  START_FAILED_END,
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
  appendRunStep,
  currentProfileId,
  endRun,
  findRun,
  hasActiveRun,
  insertRun,
  recordConfigSnapshot,
  runSteps,
} from "./records";
export type { NewRun, RunKind, StoredRun, StoredRunStep, RunStepKind } from "./records";
export { openDependencies, pickupOrder, priorityRank, READY_STATUS, statusSkip } from "./select";
export {
  HOST_CONNECT_TIMEOUT_MS,
  hostSocketSteering,
  OfficeIngest,
  STEER_TIMEOUT_MS,
  systemHostStarter,
} from "./hosts";
export type { OfficeIngestOptions, SystemHostStarterOptions } from "./hosts";
export { Watchdog, WATCHDOG_DEFAULTS } from "./watchdog";
export type { WatchdogOptions, WatchdogTimeouts } from "./watchdog";
export { activeSignals, clearSignals, LIVENESS_SIGNALS, raiseSignal } from "./signals";
export type { StoredSignal } from "./signals";
// Caps, parks and `work.stop` (DIPO-50).
export {
  CAP_TICK_MS,
  CONTROL_NOTICES,
  RECONCILED_END,
  RunControl,
  STOPPED_DETAIL,
  STORY_NOT_RUNNING,
} from "./control";
export type { ReconcileNotice, RunControlDeps, RunSteering, TrackedRun } from "./control";
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
} from "./park";
