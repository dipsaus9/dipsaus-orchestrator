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
