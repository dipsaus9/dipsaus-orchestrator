// The engine's platform entry, `@dipsaus-orchestrator/engine/platform` (0004, 0005, DIPO-318):
// the process pieces the daemon gives `createEngine` and runs itself. The lock, the socket server,
// the runtime and state directories, signals and process probes, the log, the settings file and the
// tools on the PATH, and the system implementations of the engine's process ports (spawn, the worker
// hosts, the test-box forwarders, the model proxy's listener, keep-awake). It also carries what the
// daemon's other forms run: the worker host, `dipo restore`, `dipo login box` and the test shell.
// The daemon imports from the engine only this entry, `createEngine` and types
// (`dipo/daemon-engine-imports`).

// The lock, the socket and the directories (0006 decisions 6 and 13).
export {
  acquireLock,
  helloHandshake,
  type HeldLock,
  type LockOutcome,
  type PidRecord,
} from "./platform/lock";
export {
  chooseRuntimeDir,
  currentPlatform,
  ensurePrivateDir,
  passwdHome,
  readRuntimeRecord,
  resolveSoftwareDirs,
  runtimeCandidates,
  SOCKET_FILE,
  SoftwareDirError,
  writeRuntimeRecord,
} from "./platform/paths";
export {
  CLOSE_INVALID_PAYLOAD,
  CLOSE_POLICY_VIOLATION,
  serveUnixSocket,
  type ConnectionSession,
  type ServedSocket,
  type SocketConnection,
} from "./platform/serve";
export { removeSocketFile } from "./platform/socket";
export { bootoutOwnLaunchdJob, underLaunchdJob } from "./platform/supervisor";

// Time, processes and their probes.
export { systemClock } from "./platform/clock";
export {
  detachedEnv,
  selfCommand,
  signalGroup,
  systemProcessProbe,
  systemSpawn,
  systemSpawnDetached,
  type ProcessIdentity,
  type SpawnDetached,
} from "./platform/process";
export { errorCodeOf } from "./platform/background";
export { platformSelfChecks, type SelfCheck } from "./platform/self-check";

// The log, the settings file and the tools on the PATH (DIPO-70).
export { openLogFile, type LogFile } from "./log/file";
export { createLogger, isLogLevel, LOG_LEVELS } from "./log/logger";
export { loadSoftwareConfig } from "./config/software";
export {
  resolveTools,
  sameStamp,
  systemExecutableStamp,
  type ExecutableStamp,
  type ReadExecutableStamp,
} from "./platform/tools";

// The system implementations of the engine's process ports (0005).
export { systemHostStarter } from "./run/hosts";
export { startForwarder, systemReach } from "./box/forwarder";
export { systemListenHttp, systemSpawnInteractive } from "./platform/box-host";
export { systemSpawnKeepAwake, type SpawnKeepAwake } from "./platform/keepawake";

// The daemon's other forms: the worker host (0006 decision 8), `dipo restore` (DIPO-76),
// `dipo login box` (DIPO-269) and the test shell (DIPO-309).
export { runWorkerHost } from "./host/main";
export { LAUNCH_FILE, RUN_ID_PATTERN } from "./host/protocol";
export { RUN_DIR_ENV } from "./runs/worker-hosts";
export { BackupRestoreError, restoreBackup } from "./backup/restore";
export {
  storeBoxToken,
  TOKEN_KEYCHAIN_ACCOUNT,
  TOKEN_KEYCHAIN_SERVICE,
  type SpawnInteractive,
} from "./box/token";
export { boxTokenHoldPath, clearBoxTokenHold } from "./box/token-hold";
export { testShellArgs } from "./box/apple-args";
export { containerOnPath } from "./run/box-runs";
