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
export { HOST_CONNECT_TIMEOUT_MS, OfficeIngest, systemHostStarter } from "./hosts";
export type { OfficeIngestOptions, SystemHostStarterOptions } from "./hosts";
