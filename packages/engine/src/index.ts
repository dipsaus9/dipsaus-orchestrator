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
