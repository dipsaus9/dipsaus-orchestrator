// The `lifecycle` module of `client/node` (0006 decision 2 and its 2026-10-12 amendment).

export {
  AutostartOffError,
  connectOrStart,
  connectRunning,
  DaemonStartError,
  describeStartFailure,
  inspectDaemon,
  installDaemon,
  LIFECYCLE_TIMINGS,
  restartDaemon,
  SoftwareConfigError,
  startDaemon,
  stopDaemon,
  systemLifecycleDeps,
  uninstallDaemon,
  versionHint,
} from "./lifecycle";
export type {
  ConnectedDaemon,
  DaemonObservation,
  DaemonSession,
  DaemonStatusResult,
  InstallResult,
  LifecycleDeps,
  LifecycleTimings,
  RestartResult,
  StartOptions,
  StartResult,
  StopResult,
  SystemLifecycleOptions,
  UninstallResult,
} from "./lifecycle";
export { removeIfUnchanged } from "./files";
export { systemProcessProbe } from "./process";
export { selfCommand, systemSpawnDaemon } from "./spawn";
export type { SpawnDaemon, SpawnDaemonOptions, SpawnedDaemon } from "./spawn";
export {
  autostartReport,
  daemonProgram,
  installedProgram,
  isInstalled,
  launchdDomain,
  launchdPlist,
  supervisorFile,
  supervisorStart,
  supervisorStop,
  SUPERVISOR_STOP_TIMEOUT_S,
  systemSupervisorExec,
} from "./supervisor";
export type {
  AutostartReport,
  ExecResult,
  SupervisorDeps,
  SupervisorExec,
  SupervisorStepResult,
  UnitOptions,
} from "./supervisor";
