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
export {
  ChildProcesses,
  isDaemonCommand,
  isSameProcess,
  killGroup,
  systemProcessProbe,
} from "./platform/process";
export type {
  ChildHandle,
  ProcessIdentity,
  ProcessInfo,
  ProcessProbe,
  SpawnChildOptions,
} from "./platform/process";
export { acquireLock, LockBreakError, PID_FILE } from "./platform/lock";
export type { HeldLock, LockCheck, LockOutcome, PidRecord } from "./platform/lock";
export { bindDaemonSocket, probeDaemonSocket, removeSocketFile } from "./platform/socket";
export type { BoundSocket, SocketIdentity } from "./platform/socket";
export { createLogger, DEFAULT_LOG_LEVEL, isLogLevel, LOG_LEVELS } from "./log/logger";
export type { LogContext, LogFields, Logger, LogSink } from "./log/logger";
export { DAEMON_LOG_FILE, openLogFile } from "./log/file";
export type { LogFile } from "./log/file";
export {
  appendEntries,
  cursorAt,
  headCursor,
  newEpoch,
  newLogState,
  officeStream,
  readLogState,
  SHORT_TIER_TYPES,
  tierOf,
} from "./changelog/log";
export type { AppendOptions, LogState, LogTier, NewEntry, StoredEntry } from "./changelog/log";
export { replay } from "./changelog/replay";
export type { ReplayOptions, ReplayResult } from "./changelog/replay";
export { renderDelta, Renderer, RenderError } from "./changelog/render";
export type { RenderFn } from "./changelog/render";
export { CommandError } from "./commands/errors";
export { argsInvalid, executeCommand } from "./commands/execute";
export type { ExecutorDeps } from "./commands/execute";
export { stateOfficeDirectory } from "./commands/offices";
export type { OfficeDirectory } from "./commands/offices";
export {
  buildRegistry,
  DuplicateRegistrationError,
  InvalidRegistrationError,
  Registry,
} from "./commands/registry";
export type {
  CommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
  OfficeCommandHandler,
  OfficeCommandRegistration,
  ReadContext,
  ReadHandler,
  ReadRegistration,
  SoftwareCommandContext,
  SoftwareCommandHandler,
  SoftwareCommandRegistration,
} from "./commands/registry";
export { argsHash, MemoryRequestTable, REQUEST_TTL_MS } from "./commands/requests";
export { findStoryRefFields, resolveStoryRefs } from "./commands/story-refs";
export { engineRegistry, FEATURES } from "./features";
export { executeRead } from "./reads/execute";
export type { ReadDeps } from "./reads/execute";
export {
  addStory,
  findStoryByKey,
  isProvisionalId,
  removeStory,
  renumberStory,
  resolveStoryRef,
} from "./stories/keys";
export type { NewStory, StoryIdentity, StoryResolution } from "./stories/keys";
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
export {
  KNOWN_WORKER_KINDS,
  PlanError,
  type AdapterStatus,
  type Caps,
  type ExitRecord,
  type HostLine,
  type HostOp,
  type HostSignal,
  type JsonSchema,
  type LaunchFile,
  type LaunchPlan,
  type ModelUsageTotals,
  type ParseState,
  type ResumeCheck,
  type SessionRef,
  type SteerOp,
  type UsageTotalsByModel,
  type WaitingOn,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerKind,
  type WorkerOutcome,
  type WorkerReport,
  type WorkerReportCriterion,
  type WorkerResult,
  type WorkerSpec,
} from "./workers/types";
export {
  CLAUDE_CLI_ADAPTER_ID,
  ENV_ALLOWLIST,
  PLANNED_KINDS,
  plan as planClaudeLaunch,
  REPORT_SCHEMA_FILE,
  SETTINGS_FILE,
  type ClaudeLaunchContext,
} from "./workers/claude-cli/plan";
export { encode as encodeClaudeOp } from "./workers/claude-cli/encode";
export { WORKER_REPORT_JSON_SCHEMA, WorkerReportSchema } from "./workers/claude-cli/report-schema";
