// `dipo daemon --foreground` (0006 decisions 3, 5, 6 and 13): take the PID lock, choose the runtime
// directory, bind the socket, re-read the lock, and only then open the state database (0007
// section 1). Runs until SIGTERM or SIGINT, or until the minute check finds another live daemon
// holding the lock. Lifecycle states, drain and safe mode follow in DIPO-68.

import { join } from "node:path";
import { parseArgs } from "node:util";

import type { LogLevel } from "@dipsaus-orchestrator/contract";
import {
  acquireLock,
  bindDaemonSocket,
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
  systemClock,
  systemProcessProbe,
  writeRuntimeRecord,
  type BoundSocket,
  type HeldLock,
  type Logger,
  type LogFile,
  type PidRecord,
  type StateDatabase,
} from "@dipsaus-orchestrator/engine";

import { noOrphansActive, type DaemonIo } from "./io";

/** How often the daemon checks that `dipo.pid` still holds its own record (0006 decision 6). */
const noop = () => {};

export const LOCK_CHECK_MS = 60_000;

export const FOREGROUND_USAGE =
  "dipo daemon --foreground [--log-level error|warn|info|debug|trace]";

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
export async function runForeground(args: readonly string[], io: DaemonIo): Promise<number> {
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
  let signalled: (signal: string) => void = noop;
  const shutdown = new Promise<string>((resolve) => {
    signalled = resolve;
  });
  const removeSignal = io.onShutdownSignal((signal) => signalled(signal));

  const platform = currentPlatform();
  const dirs = resolveSoftwareDirs({ platform, env: io.env, home: passwdHome() });
  ensurePrivateDir(dirs.state);
  const logFile = openLogFile(dirs.logs);
  const logger = createLogger({
    clock: systemClock,
    sinks: [logFile.sink, (line) => io.writeError(line)],
    level: parsed.level,
    component: "daemon",
  });
  try {
    return await runWithLog(io, logger, logFile, dirs.state, platform, dirs.homeMismatch, shutdown);
  } catch (error) {
    logger.error("daemon failed", { error });
    io.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    removeSignal();
    logFile.close();
  }
}

async function runWithLog(
  io: DaemonIo,
  logger: Logger,
  logFile: LogFile,
  stateDir: string,
  platform: ReturnType<typeof currentPlatform>,
  homeMismatch: { readonly env: string; readonly passwd: string } | null,
  shutdown: Promise<string>,
): Promise<number> {
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
    clock: systemClock,
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
  return serve(io, logger, logFile, stateDir, platform, outcome.lock, shutdown);
}

async function serve(
  io: DaemonIo,
  logger: Logger,
  logFile: LogFile,
  stateDir: string,
  platform: ReturnType<typeof currentPlatform>,
  lock: HeldLock,
  shutdown: Promise<string>,
): Promise<number> {
  let socket: BoundSocket | null = null;
  let database: StateDatabase | null = null;
  const timer: { handle: ReturnType<typeof systemClock.setTimeout> | null } = { handle: null };
  try {
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
    socket = bindDaemonSocket(socketPath, {
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

    database = await openStateDatabase({
      stateDir,
      logger: logger.child({ component: "database" }),
      clock: systemClock,
      engineVersion: io.version,
    });

    const code = await new Promise<number>((resolve) => {
      void shutdown.then((signal) => {
        logger.info("stopping", { signal });
        resolve(0);
      });
      const tick = () => {
        timer.handle = systemClock.setTimeout(() => {
          lock.check().then(
            (result) => {
              if (result.kind === "lost") {
                logger.error("another live daemon holds the lock; exiting", {
                  holder: result.holder.pid,
                });
                resolve(1);
                return;
              }
              tick();
            },
            (error: unknown) => {
              logger.error("lock check failed", { error });
              tick();
            },
          );
        }, LOCK_CHECK_MS);
      };
      tick();
    });
    return code;
  } finally {
    if (timer.handle !== null) systemClock.clearTimeout(timer.handle);
    database?.close();
    // Clean exit: remove dipo.sock, then dipo.pid (0006 decision 6). A daemon that lost the lock
    // leaves the socket path alone: it may belong to the daemon that holds the lock now.
    await socket?.stop({ removeFile: lock.verify() });
    lock.release();
    logger.info("daemon stopped", { log: logFile.path });
  }
}
