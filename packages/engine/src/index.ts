export const packageName = "@dipsaus-orchestrator/engine";

export { systemClock } from "./platform/clock";
export { createSystemIds, createUlid, systemIds } from "./platform/ids";
export type { RandomFill } from "./platform/ids";
export {
  AsyncTransactionError,
  IntegrityCheckError,
  NetworkFileSystemError,
} from "./platform/sqlite";
export type { DbLogger, SqlParams, SqlRow, SqliteConnection } from "./platform/sqlite";
export { openStateDatabase } from "./db/database";
export type { OpenStateDatabaseOptions, StateDatabase } from "./db/database";
export { DatabaseTooNewError, MigrationChecksumError, MigrationFailedError } from "./db/migrations";
export type { Migration, MigrateResult } from "./db/migrations";
export { OfficeHandle } from "./db/office";
export { platformSelfChecks, type SelfCheck } from "./platform/self-check";
export {
  chooseRuntimeDir,
  currentPlatform,
  ensurePrivateDir,
  lingeringEnabled,
  passwdHome,
  readRuntimeRecord,
  resolveSoftwareDirs,
  runtimeCandidates,
  RuntimeDirError,
  RUNTIME_FILE,
  SOCKET_FILE,
  writeRuntimeRecord,
} from "./platform/paths";
export type {
  DipoPlatform,
  RuntimeCandidate,
  RuntimeDirChoice,
  RuntimeRecord,
  SoftwareDirs,
} from "./platform/paths";
export { isDaemonCommand, isSameProcess, systemProcessProbe } from "./platform/process";
export type { ProcessIdentity, ProcessInfo, ProcessProbe } from "./platform/process";
export { acquireLock, LockBreakError, PID_FILE } from "./platform/lock";
export type { HeldLock, LockCheck, LockOutcome, PidRecord } from "./platform/lock";
export { bindDaemonSocket, probeDaemonSocket, removeSocketFile } from "./platform/socket";
export type { BoundSocket, SocketIdentity } from "./platform/socket";
export { createLogger, DEFAULT_LOG_LEVEL, isLogLevel, LOG_LEVELS } from "./log/logger";
export type { LogContext, LogFields, Logger, LogSink } from "./log/logger";
export { DAEMON_LOG_FILE, openLogFile } from "./log/file";
export type { LogFile } from "./log/file";
export {
  canonicalJson,
  configHash,
  FLAGS_SOURCE,
  loadOfficeConfig,
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  mergeLayer,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  OfficeConfigV1,
  OfficeFileV1,
  OfficeLocalFileV1,
  OfficeOverridesV1,
  officeJsonSchema,
  resolveOfficeConfig,
  schemaKeyPaths,
} from "./config";
export type {
  ConfigError,
  OfficeConfig,
  OfficeConfigResult,
  OfficeConfigSources,
  OfficeFile,
  OfficeLocalFile,
  OfficeOverrides,
} from "./config";
