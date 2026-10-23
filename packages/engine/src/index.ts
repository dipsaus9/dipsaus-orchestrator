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
  signalProcess,
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
export {
  checkGhVersion,
  compareVersions,
  GhHost,
  CodeHostError,
  LIST_OPEN_LIMIT,
  MIN_GH_VERSION,
  repoOfRemoteUrl,
} from "./platform/host";
export type {
  CheckBucket,
  CodeHost,
  CodeHostErrorCode,
  GhHostOptions,
  HostPr,
  NewPr,
  PrListHost,
  PrState,
  RequiredCheck,
} from "./platform/host";
export { connectUnixSocket, removeSocketFile } from "./platform/socket";
export type { ConnectOptions, RequestFrame, SocketClient, SocketReply } from "./platform/socket";
export {
  connectLineSocket,
  listenLineSocket,
  type LineConnection,
  type LineServer,
  type LineSession,
} from "./platform/line-socket";
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
export { background, errorCodeOf, failureFields } from "./platform/background";
export type { BackgroundLog, BackgroundOptions } from "./platform/background";
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
export {
  renderDelta,
  Renderer,
  RenderError,
  renderProblem,
  UNRENDERABLE_NOTICE_CODE,
  unrenderableNotice,
} from "./changelog/render";
export type { RenderFn, RenderInput } from "./changelog/render";
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
export { engineFeatures, engineRegistry, FEATURES } from "./features";
export type { EngineFeatureOptions } from "./features";
export * from "./backup";
export * from "./retention";
export * from "./git";
export type { BacklogCli } from "./backlog/runner";
export * from "./backlog/lane";
export * from "./backlog/pr";
export * from "./merge-slot";
export * from "./story-pr";
export * from "./office/init";
export * from "./run";
export * from "./hooks";
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
export {
  RECONCILE_NOTICES,
  RECONCILE_STEP,
  Reconciler,
  reconcileOffice,
  RECORDED_BY_HAND,
} from "./reconcile";
export type { ReconcileReport, ReconcilerDeps, ReconcileRuns } from "./reconcile";
export { currentProfile, diffProfiles, RunProfiles, SCAN_STEP, verifyResolved } from "./scan";
export type { RunProfilesDeps, ScanOutcome, ScanTrigger, StoredProfile } from "./scan";
export {
  evaluateGate,
  findPassingDecision,
  gateContentHash,
  GateStore,
  storeGateDecision,
} from "./gate";
export type {
  GateDecisionRecord,
  GateEvaluation,
  GateMode,
  GateResult,
  GateStoreDeps,
  RuleResult,
} from "./gate";
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
  activeWorkViews,
  columnCounts,
  columnOf,
  deriveHealth,
  deriveOfficeSummary,
  deriveStoryView,
  lifecycleOf,
  officeSummaries,
  officeSummaryOfSource,
  officeSummarySource,
  snapshot,
  storyView,
  summarySettings,
  viewsFeature,
  withWorkViews,
  workRefOf,
  workView,
} from "./views";
export type { HealthFacts, StoryFacts } from "./views";
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
  privacyOptIns,
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
  evaluateProbe,
  expandHome,
  KILL_GRACE_MS,
  MIN_BWRAP_VERSION,
  parseBwrapVersion,
  refusalPathFor,
  SANDBOX_REFUSED_EXIT_CODE,
  SANDBOX_REFUSED_MARKER,
  trustViolations,
  writableRoots,
} from "./sandbox";
export type { ProbeResult, SandboxFacts, SandboxTools, SrtSettings } from "./sandbox";
export { dipoCommand, probeSandbox, sandboxExecArgv } from "./platform/sandbox";
export { runSandboxExec } from "./platform/sandbox-exec";
export { runSafeChainGate, type SafeChainGateOptions } from "./platform/safe-chain-gate";
export {
  startSafeChainProxy,
  sweepSafeChainProxies,
  type RunningSafeChainProxy,
  type SafeChainProxyDeps,
  type SafeChainProxyRequest,
  type SafeChainProxyStart,
} from "./platform/safe-chain-proxy";
export type { SandboxExecOptions } from "./platform/sandbox-exec";
export {
  KNOWN_WORKER_KINDS,
  PlanError,
  type PlanErrorPath,
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
  type NudgeOp,
  type ParseState,
  REVIEW_SUMMARY_MAX,
  type ReportKind,
  type ResumeCheck,
  type ReviewCriterion,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewReport,
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
  EMPTY_MCP_CONFIG_FILE,
  kindContext as claudeKindContext,
  DEVELOPER_ON_MAC_REFUSED,
  PLANNED_KINDS,
  plan as planClaudeLaunch,
  REPORT_SCHEMA_FILE,
  REVIEW_TOOLS,
  SETTINGS_FILE,
  type ClaudeLaunchContext,
} from "./workers/claude-cli/plan";
export { encode as encodeClaudeOp } from "./workers/claude-cli/encode";
export {
  gateOutput as claudeGateOutput,
  PRE_TOOL_USE_NO_DECISION_MARKER as CLAUDE_GATE_NO_DECISION_MARKER,
} from "./workers/claude-cli/hooks";
export {
  parseReviewReport,
  REPORT_JSON_SCHEMAS,
  REVIEW_REPORT_JSON_SCHEMA,
  ReviewReportSchema,
  WORKER_REPORT_JSON_SCHEMA,
  WorkerReportSchema,
  type ReviewReportRead,
} from "./workers/claude-cli/report-schema";
export { readInstalledPlugins } from "./workers/claude-cli/plugins";
export {
  budgetTokens,
  currentTotals as currentClaudeTotals,
  initialState as initialClaudeState,
  interpret as interpretClaudeLine,
  interpretLogged as interpretClaudeLineLogged,
  nextSessionOptions as nextClaudeSessionOptions,
  type ClaudeParseState,
  type InitialStateOptions as ClaudeInitialStateOptions,
} from "./workers/claude-cli/interpret";
export { result as claudeResult } from "./workers/claude-cli/result";
export {
  CACHE_READ_RATE,
  CACHE_WARM_MS,
  CACHE_WRITE_1H_RATE,
  checkResume as checkClaudeResume,
  findTranscript as findClaudeTranscript,
  type ResumeCheckContext as ClaudeResumeCheckContext,
} from "./workers/claude-cli/resume-check";
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
  claudeLaunchChecks,
  prepareLaunch as prepareClaudeLaunch,
  type ClaudeLaunchCheckDeps,
  type PreparedLaunch,
} from "./workers/claude-cli/launch-checks";
export {
  claudeCliAdapter,
  claudeLaunchContext,
  claudeSessionFacts,
  claudeWorkerPort,
  type ClaudeCliAdapterDeps,
  type ClaudeWorkerPortDeps,
} from "./workers/claude-cli/adapter";
export type { PreparedWorker, RunLaunchPaths, SessionFacts, WorkerPort } from "./workers/port";
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
  HOOK_PROTOCOL_VERSIONS,
  HOST_OPS,
  HOST_PROTOCOL_VERSION,
  HOST_PROTOCOL_VERSIONS,
  MAX_HOOK_PAYLOAD,
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
export { HOOK_REPLY_GRACE_MS, relayHookPayload, type HookRelayRequest } from "./host/relay";
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
  exitFileOf,
  readHostExit,
  recordHostExit,
  recordWorkerHost,
  RUN_DIR_ENV,
  runDirectory,
  startWorkerHost,
  workerHostsOf,
  type LaunchedHost,
  type HostRecordExtras,
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
export {
  DEFAULT_OUTPUT_PRIVACY,
  INPUT_MAX_CHARS,
  oneLineInput,
  outputText,
  toolLine,
  type OutputPrivacy,
} from "./ingest/output";
export { budgetOf, finalizeAgentUsage, readUsage, type UsageScope } from "./ingest/usage";
export * from "./box/index";
export { systemListenHttp, systemSpawnInteractive } from "./platform/box-host";
export * from "./keepawake/index";
export {
  keepAwakeCommand,
  KeepAwakeMissingError,
  systemSpawnKeepAwake,
  WAIT_PID_POLL_MS,
  waitForPidExit,
  type InhibitMode,
  type KeepAwakeCommandOptions,
  type KeepAwakeExit,
  type KeepAwakeProcess,
  type SpawnKeepAwake,
} from "./platform/keepawake";
export {
  bootoutOwnLaunchdJob,
  launchdJobPid,
  systemdScopeCommand,
  systemReadCgroup,
  underLaunchdJob,
  underSystemdUnit,
  type BootoutOptions,
  type ReadCgroup,
} from "./platform/supervisor";
export {
  assembleReviewTaskMessage,
  renderSystemFile,
  type PromptStory,
  type ReviewChangedPath,
  type ReviewTaskInput,
} from "./prompts";
