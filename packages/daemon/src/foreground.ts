// `dipo daemon --foreground` (0006 decisions 3, 5, 6, 7 and 13): take the PID lock, choose the
// runtime directory, bind the socket and re-read the lock in `starting`; open and migrate the state
// database as the first recovery step in `recovering` (0007 section 1); then `running`, or `safe`
// after a crash loop. SIGTERM, SIGINT, or the minute check finding another live daemon holding the
// lock, move it to `draining`, and it exits once the drain is done or capped.

import { join } from "node:path";
import { parseArgs } from "node:util";

import type { LogLevel, TimerHandle } from "@dipsaus-orchestrator/contract";
import {
  acquireLock,
  bindDaemonSocket,
  ChildProcesses,
  chooseRuntimeDir,
  createLogger,
  currentPlatform,
  ensurePrivateDir,
  isLogLevel,
  lingeringEnabled,
  LOG_LEVELS,
  openLogFile,
  openStateDatabase,
  passwdHome,
  probeDaemonSocket,
  readRuntimeRecord,
  removeSocketFile,
  resolveSoftwareDirs,
  runtimeCandidates,
  SOCKET_FILE,
  systemProcessProbe,
  writeRuntimeRecord,
  type BoundSocket,
  type HeldLock,
  type Logger,
  type LogFile,
  type PidRecord,
  type StateDatabase,
} from "@dipsaus-orchestrator/engine";

import { CrashCounter, STABLE_RUN_MS } from "./crash-counter";
import { DEFAULT_DRAIN_CAPS, drain, type DrainCaps, type DrainRequest } from "./drain";
import { noOrphansActive, type DaemonIo } from "./io";
import { DaemonLifecycle } from "./lifecycle";
import {
  MIGRATIONS_STEP,
  runRecovery,
  RecoverySteps,
  type RecoveryContext,
  type RecoveryStep,
} from "./recovery";

/** How often the daemon checks that `dipo.pid` still holds its own record (0006 decision 6). */
export const LOCK_CHECK_MS = 60_000;

export const FOREGROUND_USAGE =
  "dipo daemon --foreground [--log-level error|warn|info|debug|trace]";

/** What the daemon is built with; tests add recovery steps and shorten the drain caps. */
export interface ForegroundOptions {
  /** Recovery steps after the migrations, in registration order (DIPO-56, DIPO-57). */
  readonly recoverySteps?: readonly RecoveryStep[];
  readonly drainCaps?: DrainCaps;
}

/** The first stop request wins: a signal, a lost lock, or later `daemon.stop` (DIPO-24). */
class StopRequests {
  #requested: DrainRequest | null = null;
  #resolve: (request: DrainRequest) => void = () => {};
  readonly promise = new Promise<DrainRequest>((resolve) => {
    this.#resolve = resolve;
  });

  get requested(): DrainRequest | null {
    return this.#requested;
  }

  request(request: DrainRequest): void {
    if (this.#requested !== null) return;
    this.#requested = request;
    this.#resolve(request);
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
  const dirs = resolveSoftwareDirs({ platform, env: io.env, home: passwdHome() });
  ensurePrivateDir(dirs.state);
  const logFile = openLogFile(dirs.logs);
  const logger = createLogger({
    clock: io.clock,
    sinks: [logFile.sink, (line) => io.writeError(line)],
    level: parsed.level,
    component: "daemon",
  });
  try {
    return await runWithLog({
      io,
      logger,
      logFile,
      stateDir: dirs.state,
      platform,
      homeMismatch: dirs.homeMismatch,
      stops,
      options,
    });
  } catch (error) {
    logger.error("daemon failed", { error });
    io.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    removeSignal();
    logFile.close();
  }
}

interface Run {
  readonly io: DaemonIo;
  readonly logger: Logger;
  readonly logFile: LogFile;
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
    handshake: async (record) => {
      const runtime = await readRuntimeRecord(stateDir);
      if (runtime === null || runtime.pid !== record.pid) return false;
      const identity = await probeDaemonSocket(runtime.socket);
      return identity?.pid === record.pid && identity.startTimeMs === record.startTimeMs;
    },
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

async function serve(run: Run, lock: HeldLock): Promise<number> {
  const { io, logger, logFile, stateDir, platform, stops, options } = run;
  const clock = io.clock;
  const lifecycle = new DaemonLifecycle("daemon started");
  lifecycle.onTransition((change) => logger.info("daemon state", { ...change }));
  const children = new ChildProcesses();
  const held: {
    socket: BoundSocket | null;
    database: StateDatabase | null;
    crashes: CrashCounter | null;
    lockTimer: TimerHandle | null;
    stableTimer: TimerHandle | null;
  } = { socket: null, database: null, crashes: null, lockTimer: null, stableTimer: null };
  let lockLost = false;
  let clean = false;
  try {
    logger.info("daemon state", { to: lifecycle.state, reason: lifecycle.reason });
    // The crash counter (0006 decision 7), opened right after the lock is taken so an unclean exit
    // anywhere later, also early in `starting`, counts as a crash: a marker left by the previous
    // daemon is one crash.
    const opened = CrashCounter.open(stateDir, lock.record(), clock);
    const crashes = opened.counter;
    held.crashes = crashes;
    if (opened.damaged) logger.warn("the crash counter was unreadable; starting it afresh");
    if (opened.previousCrashed) {
      logger.warn("the previous daemon did not exit cleanly", {
        recentCrashes: crashes.recentCrashes,
      });
    }
    const uid = process.getuid?.() ?? -1;
    const tmpBase = io.env["DIPO_TMP"] || "/tmp";
    const choice = chooseRuntimeDir({
      candidates: runtimeCandidates({
        platform,
        env: io.env,
        uid,
        lingering: platform === "linux" && lingeringEnabled(),
      }),
      uid,
      tmpBase,
    });
    for (const rejected of choice.rejected) {
      logger.warn("runtime directory candidate rejected", { ...rejected });
    }
    logger.info("runtime directory chosen", { path: choice.path, source: choice.source });
    lock.setRuntimeDir(choice.path);

    const socketPath = join(choice.path, SOCKET_FILE);
    removeSocketFile(socketPath);
    const record = lock.record();
    held.socket = bindDaemonSocket(socketPath, {
      pid: record.pid,
      startTimeMs: record.startTimeMs,
      version: record.version,
    });

    // The stale-break window (0006 decision 6): re-read the lock after binding and before
    // touching any state. The database stays closed when the lock is not ours (0007 section 1).
    if (!lock.verify()) {
      logger.error("the daemon lock does not hold this process after binding; exiting", {
        path: lock.path,
      });
      io.writeError("dipo: another daemon took the lock while this one started; exiting.");
      return 1;
    }
    writeRuntimeRecord(stateDir, {
      runtimeDir: choice.path,
      socket: socketPath,
      pid: record.pid,
      startTimeMs: record.startTimeMs,
      version: record.version,
    });
    logger.info("listening", { socket: socketPath });

    const tick = () => {
      held.lockTimer = clock.setTimeout(() => {
        held.lockTimer = null;
        lock.check().then(
          (result) => {
            if (result.kind === "lost") {
              logger.error("another live daemon holds the lock; draining", {
                holder: result.holder.pid,
              });
              lockLost = true;
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

    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async (context) => {
        held.database = await openStateDatabase({
          stateDir,
          logger: context.logger.child({ component: "database" }),
          clock,
          engineVersion: io.version,
        });
      },
    });
    for (const step of options.recoverySteps ?? []) steps.register(step);
    const context: RecoveryContext = {
      logger,
      clock,
      children,
      database: () => {
        if (held.database === null) throw new Error("the state database is not open yet");
        return held.database;
      },
    };

    if (stops.requested === null) {
      const recovery = runRecovery({
        lifecycle,
        steps,
        context,
        crashLoop: crashes.crashLoop,
      }).then(
        () => ({ kind: "settled" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const first = await Promise.race([
        recovery,
        stops.promise.then(() => ({ kind: "stop" as const })),
      ]);
      if (first.kind === "failed") throw first.error;
    }

    if (lifecycle.state === "running" || lifecycle.state === "safe") {
      held.stableTimer = clock.setTimeout(() => {
        held.stableTimer = null;
        if (lifecycle.state !== "running" && lifecycle.state !== "safe") return;
        crashes.reset();
        logger.info("stable for 10 minutes; crash counter reset");
      }, STABLE_RUN_MS);
    }

    const request = await stops.promise;
    if (held.stableTimer !== null) clock.clearTimeout(held.stableTimer);
    held.stableTimer = null;
    await drain({
      lifecycle,
      children,
      clock,
      logger,
      request,
      caps: options.drainCaps ?? DEFAULT_DRAIN_CAPS,
    });
    clean = !lockLost;
    return lockLost ? 1 : 0;
  } finally {
    if (held.lockTimer !== null) clock.clearTimeout(held.lockTimer);
    if (held.stableTimer !== null) clock.clearTimeout(held.stableTimer);
    held.database?.close();
    // Clean exit: remove dipo.sock, then dipo.pid (0006 decision 6). A daemon that lost the lock
    // leaves the socket path alone: it may belong to the daemon that holds the lock now.
    const ownsLock = lock.verify();
    if (held.socket !== null) {
      await held.socket.stop({ removeFile: ownsLock });
      logger.info("socket closed", { removed: ownsLock });
    }
    // Only a clean exit clears the crash marker; any other exit counts as a crash next start.
    if (clean) held.crashes?.cleanExit();
    lock.release();
    if (ownsLock) logger.info("lock released", { path: lock.path });
    logger.info("daemon stopped", { log: logFile.path });
  }
}
