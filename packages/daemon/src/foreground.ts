// `dipo daemon --foreground` (0006 decisions 3, 5, 6, 7 and 13): take the PID lock, choose the
// runtime directory, bind the socket and re-read the lock in `starting`; open and migrate the state
// database as the first recovery step in `recovering` (0007 section 1), with `PRAGMA quick_check`
// after an unclean exit (0007 section 10); then `running`, or `safe` after a crash loop. A database
// it cannot open or migrate keeps it in `recovering`, serving software commands with a notice that
// says what to do (0007 sections 9 and 10, DIPO-111). SIGTERM, SIGINT, or the minute check finding
// another live daemon holding the lock, move it to `draining`, and it exits once the drain is done
// or capped. An error no code caught drains it too, and that exit is a crash: exit 1 with the crash
// marker kept (DIPO-117).

import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  EXIT_CONFIG,
  type LogLevel,
  type SoftwareConfig,
  type Spawn,
  type TimerHandle,
  type ToolPaths,
} from "@dipsaus-orchestrator/contract";
import {
  createEngine,
  type DrainCaps,
  type DrainRequest,
  type Engine,
  type FeatureModule,
  type Logger,
  type Migration,
  type RecoveryStep,
  type WorkerPort,
} from "@dipsaus-orchestrator/engine";
import {
  acquireLock,
  bootoutOwnLaunchdJob,
  chooseRuntimeDir,
  createLogger,
  currentPlatform,
  detachedEnv,
  ensurePrivateDir,
  errorCodeOf,
  helloHandshake,
  isLogLevel,
  loadSoftwareConfig,
  LOG_LEVELS,
  openLogFile,
  passwdHome,
  readRuntimeRecord,
  removeSocketFile,
  resolveSoftwareDirs,
  resolveTools,
  runtimeCandidates,
  selfCommand,
  serveUnixSocket,
  SOCKET_FILE,
  SoftwareDirError,
  systemExecutableStamp,
  systemProcessProbe,
  systemSpawn,
  systemSpawnDetached,
  systemSpawnKeepAwake,
  underLaunchdJob,
  writeRuntimeRecord,
  systemHostStarter,
  startForwarder,
  systemReach,
  systemListenHttp,
  type HeldLock,
  type LogFile,
  type PidRecord,
  type ReadExecutableStamp,
  type ServedSocket,
  type SpawnDetached,
  type SpawnKeepAwake,
} from "@dipsaus-orchestrator/engine/platform";

import { CrashCounter, STABLE_RUN_MS } from "./crash-counter";
import { noOrphansActive, type DaemonIo, type UncaughtEvent, type UncaughtSource } from "./io";
import { ContractServer } from "./server";
import { UPGRADE_REASON, UpgradeWatcher } from "./upgrade";

/** How often the daemon checks that `dipo.pid` still holds its own record (0006 decision 6). */
export const LOCK_CHECK_MS = 60_000;

export const FOREGROUND_USAGE =
  "dipo daemon --foreground [--log-level error|warn|info|debug|trace]";

/** What the daemon is built with; tests add recovery steps and shorten the drain caps. */
export interface ForegroundOptions {
  /** Recovery steps after the migrations, in registration order (DIPO-56, DIPO-57). */
  readonly recoverySteps?: readonly RecoveryStep[];
  /** Replaces the compiled-in migrations; tests add a failing step (DIPO-111). */
  readonly migrations?: readonly Migration[];
  readonly drainCaps?: DrainCaps;
  /** Feature modules served next to the engine's own; tests register fixtures here. */
  readonly features?: readonly FeatureModule[];
  /** How the upgrade check reads the executable; tests replace the file system. */
  readonly readExecutableStamp?: ReadExecutableStamp;
  /** How the daemon starts the new binary after an upgrade drain; tests record the call. */
  readonly spawnDetached?: SpawnDetached;
  /** Starts the keep-awake process (0006 decision 12); tests take no real assertion. */
  readonly spawnKeepAwake?: SpawnKeepAwake;
  /** Runs `launchctl` for the bootout after a refused `config.yaml`; tests record the call. */
  readonly supervisorSpawn?: Spawn;
  /** This process's parent PID, for the launchd bootout check; tests stand in for launchd (1). */
  readonly parentPid?: number;
  /** Wraps the daemon's worker port; a test daemon process plans a scripted worker (DIPO-316). */
  readonly workerPort?: (port: WorkerPort) => WorkerPort;
}

/** The drain reason after an error no code caught (DIPO-117). */
export const UNCAUGHT_REASON = "uncaught error";

const UNCAUGHT_MESSAGES: Readonly<Record<UncaughtEvent, string>> = {
  unhandledRejection: "an unhandled rejection reached the daemon",
  uncaughtException: "an uncaught exception reached the daemon",
};

/**
 * Logs each error no code caught once, with its error code when it has one (DIPO-110), then calls
 * `onError` (DIPO-117). The listener never throws: an error thrown again from it would leave Bun
 * 1.4.2 under the binary's top-level await reporting it and running on in an unknown state (a
 * rejection), or exiting 7 at once without a drain (an exception). Known engine jobs never get here:
 * `background` catches and logs their failures. Returns the remover.
 */
export function onUncaughtErrors(
  logger: Logger,
  onError: (event: UncaughtEvent) => void,
  source: UncaughtSource = process,
): () => void {
  const listeners = (Object.keys(UNCAUGHT_MESSAGES) as UncaughtEvent[]).map((event) => {
    const listener = (error: unknown): void => {
      try {
        const code = errorCodeOf(error);
        logger.error(UNCAUGHT_MESSAGES[event], {
          error,
          ...(code === undefined ? {} : { errorCode: code }),
        });
      } catch {
        // A failing log must not stop the drain.
      }
      try {
        onError(event);
      } catch {
        // Nothing may throw from here; see above.
      }
    };
    source.on(event, listener);
    return { event, listener };
  });
  return () => {
    for (const { event, listener } of listeners) source.off(event, listener);
  };
}

/**
 * The first stop request wins: a signal, a lost lock, later `daemon.stop` (DIPO-24), or an error no
 * code caught (DIPO-117).
 */
class StopRequests {
  #requested: DrainRequest | null = null;
  #crashed = false;
  #resolve: (request: DrainRequest) => void = () => {};
  readonly promise = new Promise<DrainRequest>((resolve) => {
    this.#resolve = resolve;
  });

  get requested(): DrainRequest | null {
    return this.#requested;
  }

  /** True once an error no code caught reached the daemon: its exit is a crash. */
  get crashed(): boolean {
    return this.#crashed;
  }

  request(request: DrainRequest): void {
    if (this.#requested !== null) return;
    this.#requested = request;
    this.#resolve(request);
  }

  /**
   * An error no code caught (DIPO-117): drains with its own reason, unless a drain is already
   * requested (a signal, `daemon.stop`, an earlier error), and makes the exit a crash either way.
   */
  crash(): void {
    this.#crashed = true;
    this.request({ reason: UNCAUGHT_REASON, stopWorkers: false });
  }
}

function parseLevel(
  args: readonly string[],
  env: DaemonIo["env"],
): { level: LogLevel } | { error: string } {
  let values: { "log-level"?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { "log-level": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const level = values["log-level"] ?? env["DIPO_LOG"] ?? "info";
  if (!isLogLevel(level)) {
    return { error: `unknown log level ${JSON.stringify(level)}; use ${LOG_LEVELS.join(", ")}` };
  }
  return { level };
}

/**
 * An invalid or newer `config.yaml` stops the start with EXIT_CONFIG (78). Under launchd, exit 78
 * alone would be restarted (KeepAlive.SuccessfulExit = false): the daemon boots its own job out
 * first, so the refusal is not a restart loop (DIPO-63).
 */
async function refuseSettings(
  errors: readonly { readonly message: string }[],
  io: DaemonIo,
  logger: Logger,
  options: ForegroundOptions,
): Promise<number> {
  for (const error of errors) {
    logger.error("invalid software configuration", { ...error });
    io.writeError(`dipo: ${error.message}`);
  }
  if (underLaunchdJob(io.env)) {
    const target = await bootoutOwnLaunchdJob({
      spawn: options.supervisorSpawn ?? systemSpawn,
      uid: process.getuid?.() ?? -1,
      pid: process.pid,
      ppid: options.parentPid ?? process.ppid,
      clock: io.clock,
    });
    if (target !== null) {
      logger.error("booted the launchd job out so it is not restarted with this configuration", {
        target,
      });
    }
  }
  return EXIT_CONFIG;
}

/** Runs the daemon in this process; resolves to the exit code. `args` follow `--foreground`. */
export async function runForeground(
  args: readonly string[],
  io: DaemonIo,
  options: ForegroundOptions = {},
): Promise<number> {
  if (noOrphansActive(io)) {
    io.writeError(
      "dipo: refusing to start the daemon with --no-orphans (in the Bun flags or BUN_OPTIONS): it would stop the daemon with its parent and kill every worker on exit. Remove it from BUN_OPTIONS and start again.",
    );
    return 1;
  }
  const parsed = parseLevel(args, io.env);
  if ("error" in parsed) {
    io.writeError(`dipo: ${parsed.error}\nusage: ${FOREGROUND_USAGE}`);
    return 2;
  }

  // Listen for SIGTERM and SIGINT from the start, so a signal during startup still drains.
  const stops = new StopRequests();
  const removeSignal = io.onShutdownSignal((signal) =>
    stops.request({ reason: signal, stopWorkers: false }),
  );

  const platform = currentPlatform();
  let dirs: ReturnType<typeof resolveSoftwareDirs>;
  try {
    dirs = resolveSoftwareDirs({ env: io.env, home: passwdHome() });
  } catch (error) {
    // A `DIPO_HOME` dipo cannot use, or the real state folder in a test, stops the start before
    // anything is written (DIPO-316); like an invalid configuration, a restart would not help.
    if (!(error instanceof SoftwareDirError)) throw error;
    removeSignal();
    io.writeError(`dipo: ${error.message}`);
    return EXIT_CONFIG;
  }
  ensurePrivateDir(dirs.state);
  const logFile = openLogFile(dirs.logs);
  const logger = createLogger({
    clock: io.clock,
    sinks: [logFile.sink, (line) => io.writeError(line)],
    level: parsed.level,
    component: "daemon",
  });
  // An error no code caught (DIPO-117) drains the daemon and makes its exit a crash: the crash
  // marker stays and the exit code is 1, so the crash loop counts it (0006 decision 7).
  const removeUncaught = onUncaughtErrors(logger, () => stops.crash(), io.uncaughtErrors);
  try {
    // Software-level settings (0006 amendment of 2026-10-12), read once at start. An invalid or
    // newer file stops the start: the daemon never guesses its own settings (0017 section 5). It
    // exits with EXIT_CONFIG (78), so a supervisor does not restart it in a loop (DIPO-63).
    const settings = await loadSoftwareConfig(dirs.state);
    if (!settings.ok) return await refuseSettings(settings.errors, io, logger, options);
    logger.info("software configuration", {
      fromFile: settings.fromFile,
      ...settings.config.daemon,
    });
    const code = await runWithLog({
      io,
      logger,
      logFile,
      settings: settings.config,
      stateDir: dirs.state,
      platform,
      homeMismatch: dirs.homeMismatch,
      stops,
      options,
    });
    // Only an error no code caught in this process turns an exit 0 into 1 (DIPO-117): one that came
    // while the daemon closed down after its drain, or one in a start that then found another daemon
    // running. Without such an error, that start still exits 0, so a supervisor does not restart it.
    return code === 0 && stops.crashed ? 1 : code;
  } catch (error) {
    logger.error("daemon failed", { error });
    io.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    removeSignal();
    removeUncaught();
    logFile.close();
  }
}

interface Run {
  readonly io: DaemonIo;
  readonly logger: Logger;
  readonly logFile: LogFile;
  /** The software-level settings read at start; DIPO-70 acts on `daemon.autoRestartOnUpgrade`. */
  readonly settings: SoftwareConfig;
  readonly stateDir: string;
  readonly platform: ReturnType<typeof currentPlatform>;
  readonly homeMismatch: { readonly env: string; readonly passwd: string } | null;
  readonly stops: StopRequests;
  readonly options: ForegroundOptions;
}

async function runWithLog(run: Run): Promise<number> {
  const { io, logger, stateDir, platform, homeMismatch } = run;
  if (homeMismatch !== null) {
    logger.warn("$HOME differs from the passwd home directory; dipo uses the passwd home", {
      home: homeMismatch.env,
      passwdHome: homeMismatch.passwd,
    });
  }
  const probe = systemProcessProbe(platform);
  const own = await probe(process.pid);
  if (own === null) throw new Error(`cannot read this process's start time (pid ${process.pid})`);
  const self: PidRecord = {
    pid: process.pid,
    startTimeMs: own.startTimeMs,
    version: io.version,
    runtimeDir: null,
  };
  logger.info("daemon starting", { pid: self.pid, version: self.version, state: stateDir });

  const outcome = await acquireLock({
    stateDir,
    self,
    probe,
    clock: io.clock,
    logger,
    // Step 1 asks the running daemon itself: engine.hello, then daemon.status over ws+unix://.
    handshake: helloHandshake({
      stateDir,
      clock: io.clock,
      client: { name: "dipo daemon", version: io.version },
    }),
  });
  if (outcome.kind === "running") {
    const runtime = await readRuntimeRecord(stateDir);
    logger.info("another daemon is running", { pid: outcome.record.pid });
    io.writeLine(
      `dipo daemon is already running (pid ${outcome.record.pid}, version ${outcome.record.version}${runtime === null ? "" : `, socket ${runtime.socket}`})`,
    );
    return 0;
  }
  if (outcome.kind === "unresponsive") {
    logger.error("a daemon holds the lock but does not answer", { pid: outcome.record.pid });
    io.writeError(
      `dipo: the daemon (pid ${outcome.record.pid}) holds the lock but does not answer. Run \`dipo daemon stop --force\` to stop it.`,
    );
    return 1;
  }
  return serve(run, outcome.lock);
}

/** Where the daemon listens: its runtime directory and socket (0006 decision 13). */
interface Place {
  readonly uid: number;
  readonly runtimeDir: string;
  /** The root of each run's temp directory: `DIPO_TMP`, else `/tmp` (0017). */
  readonly tmpRoot: string;
  readonly socketPath: string;
}

/**
 * The daemon's timers, the minute lock check and the stable-run reset of the crash counter, and
 * whether the lock check found another live daemon holding the lock.
 */
interface Timers {
  lock: TimerHandle | null;
  stable: TimerHandle | null;
  lockLost: boolean;
}

/**
 * The crash counter (0006 decision 7), opened right after the lock is taken so an unclean exit
 * anywhere later, also early in `starting`, counts as a crash: a marker left by the previous daemon
 * is one crash. After an unclean exit the database may be damaged (0007 section 10): the open runs
 * `PRAGMA quick_check`. An unreadable counter cannot tell, so it counts as one, and so does a check
 * an earlier daemon left pending (`needsCheck`, DIPO-111).
 */
function openCrashes(
  run: Run,
  lock: HeldLock,
): { readonly crashes: CrashCounter; readonly checkBecause: string | null } {
  const { logger, stateDir, io } = run;
  const opened = CrashCounter.open(stateDir, lock.record(), io.clock);
  if (opened.damaged) logger.warn("the crash counter was unreadable; starting it afresh");
  if (opened.previousCrashed) {
    logger.warn("the previous daemon did not exit cleanly", {
      recentCrashes: opened.counter.recentCrashes,
    });
  }
  const checkBecause = opened.previousCrashed
    ? "unclean exit"
    : opened.damaged
      ? "crash counter unreadable"
      : opened.needsCheck
        ? "check pending from an earlier start"
        : null;
  return { crashes: opened.counter, checkBecause };
}

/** Chooses the runtime directory and the socket path in it (0006 decision 13). */
function choosePlace(run: Run, lock: HeldLock): Place {
  const { io, logger } = run;
  const uid = process.getuid?.() ?? -1;
  const tmpRoot = io.env["DIPO_TMP"] || "/tmp";
  const choice = chooseRuntimeDir({
    candidates: runtimeCandidates({ env: io.env, uid }),
    uid,
    tmpBase: tmpRoot,
    env: io.env,
  });
  for (const rejected of choice.rejected) {
    logger.warn("runtime directory candidate rejected", { ...rejected });
  }
  logger.info("runtime directory chosen", { path: choice.path, source: choice.source });
  lock.setRuntimeDir(choice.path);
  const socketPath = join(choice.path, SOCKET_FILE);
  removeSocketFile(socketPath);
  return { uid, runtimeDir: choice.path, tmpRoot, socketPath };
}

/**
 * Tool paths from this daemon's PATH, which the starting client kept (DIPO-70). A missing tool is
 * reported, never a reason to stop the start.
 */
function daemonTools(run: Run): ToolPaths {
  const tools = resolveTools(run.io.env["PATH"]);
  run.logger.info("tools resolved", { ...tools.paths, missing: tools.missing });
  for (const tool of tools.missing) run.logger.warn("tool not found on PATH", { tool });
  return tools.paths;
}

/**
 * Upgrades (0006 decision 14): checked every minute; an automatic restart waits while the engine
 * is busy. Once any stop is requested the watcher counts as busy and stops, so a daemon someone
 * stopped never starts a new binary on its own.
 */
function upgradeWatcher(run: Run): UpgradeWatcher {
  const { io, logger, stops, options } = run;
  const command = selfCommand();
  const watcher = new UpgradeWatcher({
    clock: io.clock,
    logger,
    executable: command[command.length - 1] ?? process.execPath,
    readStamp: options.readExecutableStamp ?? systemExecutableStamp,
    autoRestart: run.settings.daemon.autoRestartOnUpgrade,
    restart: () => stops.request({ reason: UPGRADE_REASON, stopWorkers: false }),
  });
  void stops.promise.then(() => watcher.stop());
  return watcher;
}

/** The engine, from this daemon's process concerns (0005). */
function startEngine(
  run: Run,
  place: Place,
  parts: {
    readonly lock: HeldLock;
    readonly crashes: CrashCounter;
    readonly checkBecause: string | null;
    readonly upgrade: UpgradeWatcher;
  },
): Engine {
  const { io, logger, stateDir, options } = run;
  const record = parts.lock.record();
  const probe = systemProcessProbe(run.platform);
  return createEngine({
    clock: io.clock,
    logger,
    spawn: systemSpawn,
    probe,
    spawnKeepAwake: options.spawnKeepAwake ?? systemSpawnKeepAwake,
    // Worker hosts run detached as `dipo daemon worker-host <run>` (0006 decision 8).
    hosts: systemHostStarter({
      clock: io.clock,
      runtimeDir: place.runtimeDir,
      dipoCommand: selfCommand(),
      env: io.env,
      probe,
    }),
    forwarders: { forward: startForwarder, reach: systemReach },
    listenHttp: systemListenHttp,
    env: io.env,
    paths: { stateDir, runtimeDir: place.runtimeDir, tmpRoot: place.tmpRoot, home: passwdHome() },
    tools: daemonTools(run),
    settings: run.settings,
    daemon: {
      pid: record.pid,
      uid: place.uid,
      version: io.version,
      ...(io.buildCommit === undefined ? {} : { buildCommit: io.buildCommit }),
      startedAt: io.clock.now(),
      socket: place.socketPath,
      upgradePending: () => parts.upgrade.pending,
      requestStop: (request) => run.stops.request(request),
    },
    databaseCheck: {
      because: parts.checkBecause,
      needsCheck: (value) => parts.crashes.setNeedsCheck(value),
    },
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    ...(options.recoverySteps === undefined ? {} : { recoverySteps: options.recoverySteps }),
    ...(options.features === undefined ? {} : { features: options.features }),
    ...(options.workerPort === undefined ? {} : { workerPort: options.workerPort }),
  });
}

/**
 * The stale-break window (0006 decision 6): the lock is read again after binding and before any
 * state is touched; then `runtime.json` names the socket, and every minute the lock is checked.
 */
function claimPlace(run: Run, lock: HeldLock, place: Place, timers: Timers): boolean {
  const { io, logger, stops, stateDir } = run;
  if (!lock.verify()) {
    logger.error("the daemon lock does not hold this process after binding; exiting", {
      path: lock.path,
    });
    io.writeError("dipo: another daemon took the lock while this one started; exiting.");
    return false;
  }
  const record = lock.record();
  writeRuntimeRecord(stateDir, {
    runtimeDir: place.runtimeDir,
    socket: place.socketPath,
    pid: record.pid,
    startTimeMs: record.startTimeMs,
    version: record.version,
  });
  logger.info("listening", { socket: place.socketPath });
  const tick = () => {
    timers.lock = io.clock.setTimeout(() => {
      timers.lock = null;
      lock.check().then(
        (result) => {
          if (result.kind === "lost") {
            logger.error("another live daemon holds the lock; draining", {
              holder: result.holder.pid,
            });
            timers.lockLost = true;
            stops.request({ reason: "lock lost", stopWorkers: false });
            return;
          }
          if (stops.requested === null) tick();
        },
        (error: unknown) => {
          logger.error("lock check failed", { error });
          if (stops.requested === null) tick();
        },
      );
    }, LOCK_CHECK_MS);
  };
  tick();
  return true;
}

/**
 * Recovery (0006 decision 7), unless a stop came first: a stop during recovery lets the current
 * step finish and the drain follows. In `running` or `safe`, ten stable minutes reset the crash
 * counter.
 */
async function recover(
  run: Run,
  engine: Engine,
  crashes: CrashCounter,
  timers: Timers,
): Promise<void> {
  const { stops, io, logger } = run;
  if (stops.requested === null) {
    const recovery = engine.recover({ crashLoop: crashes.crashLoop }).then(
      () => ({ kind: "settled" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const first = await Promise.race([
      recovery,
      stops.promise.then(() => ({ kind: "stop" as const })),
    ]);
    if (first.kind === "failed") throw first.error;
  }
  const state = engine.state();
  if (state !== "running" && state !== "safe") return;
  timers.stable = io.clock.setTimeout(() => {
    timers.stable = null;
    const now = engine.state();
    if (now !== "running" && now !== "safe") return;
    crashes.reset();
    logger.info("stable for 10 minutes; crash counter reset");
  }, STABLE_RUN_MS);
}

/** What the daemon closes down at its exit. */
interface Held {
  readonly lock: HeldLock;
  readonly timers: Timers;
  upgrade: UpgradeWatcher | null;
  engine: Engine | null;
  server: ContractServer | null;
  socket: ServedSocket | null;
  crashes: CrashCounter | null;
}

/**
 * Closes down in order: the timers and the upgrade check, the engine's services, the server, the
 * socket, then the database (0007 section 10), the crash marker on a clean exit and the lock. A
 * daemon that lost the lock leaves the socket path alone: it may belong to the daemon that holds
 * the lock now.
 */
async function closeDown(run: Run, held: Held, clean: boolean): Promise<void> {
  const { io, logger, logFile, stops } = run;
  const { lock, timers } = held;
  if (timers.lock !== null) io.clock.clearTimeout(timers.lock);
  if (timers.stable !== null) io.clock.clearTimeout(timers.stable);
  held.upgrade?.stop();
  await held.engine?.stop();
  // No more debounced office summaries once the daemon stops.
  held.server?.close();
  const ownsLock = lock.verify();
  try {
    if (held.socket !== null) {
      await held.socket.stop({ removeFile: ownsLock });
      logger.info("socket closed", { removed: ownsLock });
    }
  } finally {
    // Last, after every engine service stopped and the connections closed (1001), so no request
    // reaches a closed database. A failure is a warn, never a crash (DIPO-87).
    held.engine?.closeDatabase();
  }
  // Only a clean exit clears the crash marker; any other exit counts as a crash next start. An
  // error no code caught while the daemon closed down makes it unclean too (DIPO-117).
  const cleanExit = clean && !stops.crashed;
  if (cleanExit) held.crashes?.cleanExit();
  lock.release();
  if (ownsLock) logger.info("lock released", { path: lock.path });
  // An upgrade drain ends in the new binary (0006 decision 14), started only now that the lock and
  // the socket are free, with the same environment minus the Bun flag variables.
  if (
    cleanExit &&
    stops.requested?.reason === UPGRADE_REASON &&
    held.upgrade?.restarting === true
  ) {
    startNewBinary(run);
  }
  logger.info("daemon stopped", { log: logFile.path });
}

function startNewBinary(run: Run): void {
  const { io, logger, options } = run;
  try {
    const started = (options.spawnDetached ?? systemSpawnDetached)({
      cmd: [...selfCommand(), "daemon", "--foreground", "--log-level", logger.level()],
      cwd: process.cwd(),
      env: detachedEnv(io.env),
      outputFile: "/dev/null",
    });
    logger.info("started the new binary", { pid: started.pid });
  } catch (error) {
    logger.error("could not start the new binary; run `dipo daemon start`", { error });
  }
}

/** Serves the engine on the socket until a stop, then drains; resolves to the exit code. */
async function serve(run: Run, lock: HeldLock): Promise<number> {
  const { io, logger, stops, options } = run;
  const held: Held = {
    lock,
    timers: { lock: null, stable: null, lockLost: false },
    upgrade: null,
    engine: null,
    server: null,
    socket: null,
    crashes: null,
  };
  let clean = false;
  try {
    const { crashes, checkBecause } = openCrashes(run, lock);
    held.crashes = crashes;
    const place = choosePlace(run, lock);
    const upgrade = upgradeWatcher(run);
    held.upgrade = upgrade;
    const engine = startEngine(run, place, { lock, crashes, checkBecause, upgrade });
    held.engine = engine;
    const server = new ContractServer({
      engine,
      clock: io.clock,
      logger: logger.child({ component: "server" }),
      // "Since you left" counts from when the office's last TUI client disconnected (DIPO-308).
      tuiLeft: (office, at) => engine.tuiLeft(office, at),
    });
    held.server = server;
    server.onPresenceChanged(() => engine.setTuiPresent(server.presence.tuiConnected()));
    held.socket = serveUnixSocket(place.socketPath, (connection) => server.accept(connection));
    if (!claimPlace(run, lock, place, held.timers)) return 1;
    upgrade.start(() => stops.requested !== null || engine.busy());
    await recover(run, engine, crashes, held.timers);
    const request = await stops.promise;
    if (held.timers.stable !== null) io.clock.clearTimeout(held.timers.stable);
    held.timers.stable = null;
    await engine.drain(request, options.drainCaps);
    // A requested drain exits 0 and is no crash, even at its cap (DIPO-68). After an error no code
    // caught it is a crash, whichever reason the drain has.
    if (stops.crashed) {
      logger.error("exiting 1 after an uncaught error; the next start counts a crash", {
        reason: request.reason,
      });
    }
    clean = !held.timers.lockLost && !stops.crashed;
    return clean ? 0 : 1;
  } finally {
    await closeDown(run, held, clean);
  }
}
