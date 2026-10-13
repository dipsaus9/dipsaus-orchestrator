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
  detachedEnv,
  isDaemonCommand,
  isSameProcess,
  killGroup,
  selfCommand,
  signalGroup,
  systemProcessProbe,
  systemSpawn,
  systemSpawnDetached,
} from "./platform/process";
export type {
  ChildHandle,
  DetachedSpawnOptions,
  SpawnDetached,
  ProcessIdentity,
  ProcessInfo,
  ProcessProbe,
  SpawnChildOptions,
} from "./platform/process";
export {
  acquireLock,
  HANDSHAKE_TIMEOUT_MS,
  helloHandshake,
  LockBreakError,
  PID_FILE,
} from "./platform/lock";
export type {
  HeldLock,
  HelloHandshakeOptions,
  LockCheck,
  LockOutcome,
  PidRecord,
} from "./platform/lock";
export {
  resolveTools,
  sameStamp,
  systemExecutableStamp,
  systemIsExecutable,
  TOOL_NAMES,
} from "./platform/tools";
export type {
  ExecutableStamp,
  IsExecutable,
  ReadExecutableStamp,
  ResolvedTools,
  ToolName,
} from "./platform/tools";
export { connectUnixSocket, removeSocketFile } from "./platform/socket";
export type { ConnectOptions, RequestFrame, SocketClient, SocketReply } from "./platform/socket";
export {
  BACKPRESSURE_LIMIT_BYTES,
  CLOSE_GOING_AWAY,
  CLOSE_INVALID_PAYLOAD,
  CLOSE_POLICY_VIOLATION,
  CLOSE_UNSUPPORTED_DATA,
  MAX_FRAME_BYTES,
  serveUnixSocket,
} from "./platform/serve";
export type {
  AcceptConnection,
  ConnectionSession,
  ServedSocket,
  SendResult,
  ServeOptions,
  SocketConnection,
} from "./platform/serve";
export { SOFTWARE_STREAM, SOFTWARE_STREAM_CAPACITY, SoftwareStream } from "./software-stream";
export type { SoftwareListener, SoftwareReplay, SoftwareStreamOptions } from "./software-stream";
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
export { officeUnknown, stateOfficeDirectory } from "./commands/offices";
export type { OfficeAccess, OfficeDirectory } from "./commands/offices";
export {
  BACKLOG_CONFIG,
  canonicalPath,
  isBacklogProject,
  mainWorktreeOf,
  MARKER_FILE,
  markerPath,
  networkFsType,
  OFFICE_DIR,
  officeDirectory,
  officeFeature,
  OfficeManager,
  OfficeMarker,
  readMarker,
  resolveRepository,
  writeMarker,
} from "./office";
export type {
  ActiveWorkCheck,
  GitRunner,
  LoadStep,
  LoadStepResult,
  MarkerRead,
  OfficeLoadContext,
  OfficeManagerDeps,
  OpenResult,
  RegisteredActiveWorkCheck,
  RegisteredLoadStep,
  ReloadConfigResult,
  Repository,
  ResolveResult,
} from "./office";
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
export * from "./git";
export * from "./backlog/lane";
export * from "./worktree";
export { formatGigabytes, systemDiskProbe } from "./platform/disk";
export type { DiskProbe } from "./platform/disk";
export { executeRead } from "./reads/execute";
export type { ReadDeps } from "./reads/execute";
export {
  CAPABILITY_FLAGS,
  capabilityFlags,
  contractUnsupported,
  helloFeature,
  noOfficeSummaries,
} from "./reads/hello";
export type { HelloSource, OfficeSummarySource } from "./reads/hello";
export { currentProfile, diffProfiles, RunProfiles, SCAN_STEP, verifyResolved } from "./scan";
export type { RunProfilesDeps, ScanOutcome, ScanTrigger, StoredProfile } from "./scan";
export {
  addStory,
  applyIndex,
  contentHash,
  findStoryByKey,
  INDEX_STEP,
  indexStories,
  isProvisionalId,
  readBacklog,
  removeStory,
  renumberStories,
  renumberStory,
  resolveStoryRef,
  StoryIndex,
} from "./stories";
export type {
  BacklogStory,
  IndexResult,
  IndexStats,
  NewStory,
  StoryIdentity,
  StoryIndexDeps,
  StoryMove,
  StoryResolution,
} from "./stories";
export {
  columnCounts,
  columnOf,
  deriveOfficeSummary,
  deriveStoryView,
  lifecycleOf,
  officeSummaries,
  officeSummarySource,
  storyView,
} from "./views";
export type { StoryFacts } from "./views";
export {
  canonicalJson,
  configHash,
  FLAGS_SOURCE,
  loadOfficeConfig,
  loadSoftwareConfig,
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
  softwareConfigPath,
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
  DENY_ALL_SETTINGS,
  evaluateProbe,
  expandHome,
  KILL_GRACE_MS,
  linuxLiteralPath,
  MIN_BWRAP_VERSION,
  OUTPUT_LIMIT_BYTES,
  parseBwrapVersion,
  refusalPathFor,
  runSandboxedStep,
  SANDBOX_REFUSED_EXIT_CODE,
  SANDBOX_REFUSED_MARKER,
  EXTRA_SECRET_HOME_PATHS,
  isRuntimeOptionName,
  SECRET_HOME_PATHS,
  STEP_ENV_ALLOWLIST,
  stepEnv,
  translatePolicy,
  trustViolations,
  writableRoots,
} from "./sandbox";
export type {
  CapturedOutput,
  ProbeResult,
  SandboxFacts,
  SandboxHost,
  SandboxRun,
  SandboxTools,
  SrtSettings,
  StepDeps,
  StepPolicyKind,
  StepRequest,
  StepResult,
  TranslatedPolicy,
} from "./sandbox";
export {
  dipoCommand,
  probeSandbox,
  sandboxExecArgv,
  STEP_TEMP_PREFIX,
  systemSandboxHost,
} from "./platform/sandbox";
export { runSandboxExec } from "./platform/sandbox-exec";
export type { SandboxExecOptions } from "./platform/sandbox-exec";
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
  type WorkerRetry,
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
export {
  budgetTokens,
  currentTotals as currentClaudeTotals,
  initialState as initialClaudeState,
  interpret as interpretClaudeLine,
  interpretLogged as interpretClaudeLineLogged,
  type ClaudeParseState,
  type InitialStateOptions as ClaudeInitialStateOptions,
} from "./workers/claude-cli/interpret";
export { result as claudeResult } from "./workers/claude-cli/result";
export { ClaudeWorkerEventSchema } from "./workers/claude-cli/schema";
export {
  AdapterHolds,
  gateLaunch,
  HOLD_NOTICE_CODE,
  holdMessage,
  RELEASE_NOTICE_CODE,
  type AdapterHold,
  type AdapterHoldsOptions,
  type HoldNotice,
  type LaunchCheckFailure,
  type LaunchCheckOutcome,
  type LaunchGate,
} from "./workers/hold";
export {
  CLAUDE_CLI_CAPABILITIES,
  MIN_CLAUDE_VERSION,
  probe as probeClaude,
  REQUIRED_AUTH_METHOD,
} from "./workers/claude-cli/probe";
export {
  checkProjectSettings,
  LOCAL_STRIPPED_KEYS,
  SAFE_PROJECT_SETTINGS,
  stripLocalSettings,
} from "./workers/claude-cli/settings-check";
export {
  bashCalls as selfTestBashCalls,
  judgeSelfTest,
  resolveSelfTestTools,
  workerWritableRoots,
  PROBE_GROUPS,
  runSelfTest,
  SELF_TEST_EFFORT,
  SELF_TEST_MODEL,
  SELF_TEST_SYSTEM_PROMPT,
  selfTestLayout,
  type ProbeName,
  type SelfTestDisk,
  type SelfTestEvidence,
  type SelfTestBashCalls,
  type SelfTestTools,
  type SelfTestVerdict,
} from "./workers/claude-cli/self-test";
export {
  credentialCommands,
  engineCredentialCheck,
  GH_KEYCHAIN_SERVICE,
  judgeCredentialStep,
  KEYCHAIN_TOOL,
  CREDENTIAL_MARKER,
  marked,
  type CredentialCheckResult,
  type CredentialProbe,
  type RunStep,
} from "./workers/credential-check";
export {
  claudeLaunchChecks,
  prepareLaunch as prepareClaudeLaunch,
  type ClaudeLaunchCheckDeps,
  type PreparedLaunch,
} from "./workers/claude-cli/launch-checks";
export {
  ScriptedWorker,
  ScriptError,
  scriptProblems,
  type EventSchema,
  type ScriptedWorkerOptions,
} from "./workers/scripted";
export {
  EVENTS_FILE,
  EXIT_FILE,
  HOST_LOG_CAP_BYTES,
  HOST_LOG_FILE,
  HOST_OPS,
  HOST_PROTOCOL_VERSION,
  HOST_PROTOCOL_VERSIONS,
  HostExitFileSchema,
  hostSocketPath,
  HOSTS_DIR,
  LAUNCH_FILE,
  RUN_ID_PATTERN,
  type HostError,
  type HostErrorCode,
  type HostExitFile,
  type HostLaunch,
  type HostOpName,
  type HostState,
  type HostStatus,
} from "./host/protocol";
export { runWorkerHost, WorkerHost, type WorkerHostOptions } from "./host/main";
export {
  connectHost,
  type ConnectHostOptions,
  type ConnectHostResult,
  type HostClient,
  type HostReply,
  type HostRequest,
} from "./host/client";
export {
  hostAlive,
  HostStartError,
  launchWorkerHost,
  recordHostExit,
  recordWorkerHost,
  RUN_DIR_ENV,
  runDirectory,
  startWorkerHost,
  workerHostsOf,
  type LaunchedHost,
  type LaunchWorkerHostOptions,
  type WorkerHostRow,
} from "./runs/worker-hosts";
export {
  FILE_CHANGED_CODE,
  fileChangedRuns,
  INGEST_DEFAULTS,
  Ingestor,
  type AdvancedSource,
  type FileChangedReport,
  type IngestAdapter,
  type IngestHooks,
  type IngestorOptions,
  type IngestTarget,
  type IngestTimings,
  type PassResult,
  type PassStatus,
} from "./ingest/ingestor";
export { outputText, toolLine } from "./ingest/output";
export { budgetOf, finalizeAgentUsage, readUsage, type UsageScope } from "./ingest/usage";
