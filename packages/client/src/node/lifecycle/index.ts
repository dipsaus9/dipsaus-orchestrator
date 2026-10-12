// The `lifecycle` module of `client/node` (0006 decision 2 and its 2026-10-12 amendment).

export {
  AutostartOffError,
  connectOrStart,
  DaemonStartError,
  describeStartFailure,
  inspectDaemon,
  LIFECYCLE_TIMINGS,
  restartDaemon,
  SoftwareConfigError,
  startDaemon,
  stopDaemon,
  systemLifecycleDeps,
  versionHint,
} from "./lifecycle";
export type {
  ConnectedDaemon,
  DaemonObservation,
  DaemonSession,
  DaemonStatusResult,
  LifecycleDeps,
  LifecycleTimings,
  RestartResult,
  StartOptions,
  StartResult,
  StopResult,
  SystemLifecycleOptions,
} from "./lifecycle";
export { PID_FILE, parsePidRecord, removeIfUnchanged } from "./files";
export type { PidRecord } from "./files";
export {
  isDaemonCommand,
  isSameProcess,
  parseLstart,
  parsePsLine,
  parseProcStat,
  systemProcessProbe,
} from "./process";
export type { ProcessInfo, ProcessProbe } from "./process";
export { BUN_FLAG_VARIABLES, daemonEnv, selfCommand, systemSpawnDaemon } from "./spawn";
export type { SpawnDaemon, SpawnDaemonOptions, SpawnedDaemon } from "./spawn";
