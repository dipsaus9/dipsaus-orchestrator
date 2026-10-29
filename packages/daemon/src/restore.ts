// `dipo restore <file>` (0007 section 10): named offline maintenance outside the contract (0006
// amendment of 2026-10-12), so it runs daemon-side code through `runDaemon`. It takes the daemon
// lock `dipo.pid` the way a starting daemon does (0006 decision 6), which refuses while a live
// daemon holds it, then replaces `dipo.db` with the backup (engine `restoreBackup`) and releases
// the lock. The next daemon start migrates the file when it is older and reconciles each office.

import { resolve } from "node:path";

import type { Logger } from "@dipsaus-orchestrator/engine";
import {
  acquireLock,
  createLogger,
  currentPlatform,
  ensurePrivateDir,
  helloHandshake,
  type LockOutcome,
  openLogFile,
  passwdHome,
  type PidRecord,
  resolveSoftwareDirs,
  restoreBackup,
  BackupRestoreError,
  systemProcessProbe,
} from "@dipsaus-orchestrator/engine/platform";

import type { DaemonIo } from "./io";

export const RESTORE_USAGE = "dipo restore <file>";

export interface RestoreFormOptions {
  /** Takes the daemon lock; tests replace it to stand in for a live daemon. */
  readonly acquire?: (stateDir: string, logger: Logger, io: DaemonIo) => Promise<LockOutcome>;
}

/** Takes `dipo.pid` as `dipo daemon --foreground` does: a live daemon is reported, a stale record broken. */
async function systemAcquire(stateDir: string, logger: Logger, io: DaemonIo): Promise<LockOutcome> {
  const probe = systemProcessProbe(currentPlatform());
  const own = await probe(process.pid);
  if (own === null) throw new Error(`cannot read this process's start time (pid ${process.pid})`);
  const self: PidRecord = {
    pid: process.pid,
    startTimeMs: own.startTimeMs,
    version: io.version,
    runtimeDir: null,
  };
  return acquireLock({
    stateDir,
    self,
    probe,
    clock: io.clock,
    logger,
    handshake: helloHandshake({
      stateDir,
      clock: io.clock,
      client: { name: "dipo restore", version: io.version },
    }),
  });
}

/** Runs `dipo restore <file>`; resolves to the exit code. */
export async function runRestoreForm(
  args: readonly string[],
  io: DaemonIo,
  options: RestoreFormOptions = {},
): Promise<number> {
  const [given, ...rest] = args;
  if (given === undefined || given === "" || given.startsWith("-") || rest.length > 0) {
    io.writeError(`dipo: restore needs one backup file\nusage: ${RESTORE_USAGE}`);
    return 2;
  }
  const file = resolve(given);
  const dirs = resolveSoftwareDirs({ env: io.env, home: passwdHome() });
  ensurePrivateDir(dirs.state);
  const logFile = openLogFile(dirs.logs);
  const logger = createLogger({ clock: io.clock, sinks: [logFile.sink], component: "restore" });
  try {
    const outcome = await (options.acquire ?? systemAcquire)(dirs.state, logger, io);
    if (outcome.kind === "running") {
      logger.warn("restore refused: the daemon is running", { pid: outcome.record.pid });
      io.writeError(
        `dipo: the daemon is running (pid ${outcome.record.pid}) and has the state database open. Stop it with \`dipo daemon stop\`, then run \`dipo restore ${given}\` again.`,
      );
      return 1;
    }
    if (outcome.kind === "unresponsive") {
      logger.warn("restore refused: a daemon holds the lock", { pid: outcome.record.pid });
      io.writeError(
        `dipo: the daemon (pid ${outcome.record.pid}) holds the lock but does not answer. Stop it with \`dipo daemon stop --force\`, then run \`dipo restore ${given}\` again.`,
      );
      return 1;
    }
    const lock = outcome.lock;
    try {
      const result = restoreBackup({ stateDir: dirs.state, file });
      logger.info("restored the state database", {
        file,
        path: result.path,
        schemaVersion: result.schemaVersion,
        offices: result.offices.length,
        removed: result.removed,
      });
      io.writeLine(`restored ${file} into ${result.path}`);
      io.writeLine(
        `${result.offices.length} ${result.offices.length === 1 ? "office has" : "offices have"} a new epoch; clients reset their view when they reconnect`,
      );
      io.writeLine(
        "the next `dipo daemon start` migrates the file if needed and reconciles each office with Backlog.md and git",
      );
      return 0;
    } catch (error) {
      if (!(error instanceof BackupRestoreError)) throw error;
      if (error.walLost) {
        // The live file lost its WAL: it is not unchanged, and only a backup brings it back.
        logger.error(
          "restore failed after deleting the live -wal and -shm; dipo.db lost its recent commits",
          {
            file,
            reason: error.message,
          },
        );
        io.writeError(`dipo: ${error.message}`);
        return 1;
      }
      logger.warn("restore refused", { file, reason: error.message });
      io.writeError(`dipo: ${error.message} Nothing was restored.`);
      return 1;
    } finally {
      lock.release();
    }
  } finally {
    logFile.close();
  }
}
