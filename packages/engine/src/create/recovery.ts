// Recovery steps (0005, 0007). In `recovering` the engine runs the steps it lists, in their one
// order, with the database migrations always first; then it enters `running`. Reconcile and
// re-attach plug in here. A drain that starts during recovery lets the current step finish and runs
// no further step.
//
// A state database that cannot be opened or migrated (0005, 0007) does not stop the daemon: the
// migrations step holds it in `recovering` with a `DatabaseFailure` from `databaseFailure` below,
// no further step runs, and the daemon serves software commands until it is stopped. Exiting
// instead would make a supervisor restart it in a loop, and every start would write another
// pre-migration backup.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Clock, DatabaseUnavailableReason } from "@dipsaus-orchestrator/contract";
import { backupsDirectory, preMigrationBackups } from "../backup/files";
import {
  DatabaseTooNewError,
  MigrationChecksumError,
  MigrationFailedError,
} from "../db/migrations";
import type { Logger } from "../log/logger";
import type { ChildProcesses } from "../platform/process";
import { NetworkFileSystemError } from "../platform/sqlite";

import type { DaemonLifecycle, DatabaseFailure } from "./lifecycle";

export interface RecoveryContext {
  readonly logger: Logger;
  readonly clock: Clock;
  /** Child processes a step starts go through here, so the drain waits for them. */
  readonly children: ChildProcesses;
}

export interface RecoveryStep {
  readonly name: string;
  run(context: RecoveryContext): Promise<void>;
}

export const MIGRATIONS_STEP = "migrations";

/** The ordered recovery steps; the migrations step is always the first. */
export class RecoverySteps {
  readonly #steps: RecoveryStep[];

  constructor(migrations: RecoveryStep) {
    this.#steps = [migrations];
  }

  /** Adds a step after every step registered before it. */
  register(step: RecoveryStep): void {
    if (this.#steps.some((s) => s.name === step.name)) {
      throw new Error(`A recovery step named ${JSON.stringify(step.name)} is already registered.`);
    }
    this.#steps.push(step);
  }

  list(): readonly RecoveryStep[] {
    return [...this.#steps];
  }
}

export interface RunRecoveryOptions {
  readonly lifecycle: DaemonLifecycle;
  readonly steps: RecoverySteps;
  readonly context: RecoveryContext;
}

/**
 * Moves `starting` to `recovering`, runs every step, then enters `running`. Resolves to false when
 * a drain began before recovery finished, or when a step held the daemon in `recovering` because
 * the state database is unavailable; a failing step rejects.
 */
export async function runRecovery(options: RunRecoveryOptions): Promise<boolean> {
  const { lifecycle, steps, context } = options;
  // Read through a function: a drain may change the state while a step runs.
  const recovering = () => lifecycle.state === "recovering" && lifecycle.unavailable === null;
  if (lifecycle.state !== "starting") return false;
  lifecycle.transition("recovering", "running recovery steps");
  for (const step of steps.list()) {
    if (!recovering()) return false;
    const end = lifecycle.beginWork();
    if (end === null) return false;
    context.logger.info("recovery step", { step: step.name });
    try {
      await step.run(context);
    } catch (error) {
      context.logger.error("recovery step failed", { step: step.name, error });
      throw error;
    } finally {
      end();
    }
  }
  if (!recovering()) return false;
  lifecycle.transition("running", "recovered");
  return true;
}

/** SQLite finding the file damaged or no database at all. */
function isDamage(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" && (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT"))
  );
}

/** `PRAGMA user_version` from the file header (offset 60, big-endian); null when unreadable. */
function headerUserVersion(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(4);
    if (readSync(fd, bytes, 0, 4, 60) !== 4) return null;
    return bytes.readUInt32BE(0);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The newest pre-migration backup in `<state>/backups` that holds a schema (0007), by modification
 * time; null when there is none. A pre-migration copy of a database
 * that was still empty has `user_version` 0 and restores nothing, so it is never named.
 */
export function newestBackup(stateDir: string): string | null {
  const dir = backupsDirectory(join(stateDir, "dipo.db"));
  let newest: { path: string; at: number } | null = null;
  for (const name of preMigrationBackups(dir)) {
    const path = join(dir, name);
    let at: number;
    try {
      at = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (newest !== null && at <= newest.at) continue;
    const version = headerUserVersion(path);
    if (version === null || version === 0) continue;
    newest = { path, at };
  }
  return newest?.path ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recovery by hand (0007): stop the daemon, move `dipo.db` away or copy the pre-migration backup in,
 * then start. Its `-wal` and `-shm` files go too, so a stale log is never replayed over the copy.
 * Losing the file loses run history only; the next start rebuilds the rest.
 */
function restoreSteps(stateDir: string, backup: string | null): string {
  const db = join(stateDir, "dipo.db");
  if (backup !== null) {
    return `Run \`dipo daemon stop\`, move ${db} and its -wal and -shm files away, or delete those two files and copy ${backup} over ${db}, then start the daemon again.`;
  }
  return `Run \`dipo daemon stop\`, move ${db} and its -wal and -shm files away (${backupsDirectory(db)} holds no backup), then start the daemon again; \`dipo office open\` registers each repository again.`;
}

/** `problem` says what failed, `action` what to do; both are whole sentences. */
function failure(
  reason: DatabaseUnavailableReason,
  problem: string,
  action: string,
  backup: string | null = null,
): DatabaseFailure {
  return {
    details: { reason, ...(backup === null ? {} : { backup }) },
    text: `${problem} No office is loaded. ${action}`,
  };
}

/**
 * What a failed open or migration of the state database means for the maintainer (0007 sections 9
 * and 10, DIPO-111): the reason, the newest backup when one exists, and one paragraph
 * that says what to do. A failed migration left `dipo.db` as it was (the step rolled back), so the
 * fix is a dipo whose migrations work: the previous version or a fixed release; the backup is for
 * a file that is itself suspect. An edited migration, a damaged file or any other failure: stop
 * the daemon and move the file away or copy the newest backup in. A too-new database: upgrade dipo. A network
 * filesystem: move the state directory.
 */
export function databaseFailure(error: unknown, stateDir: string): DatabaseFailure {
  if (error instanceof NetworkFileSystemError) {
    return failure(
      "networkFilesystem",
      `The state directory ${error.path} is on a network filesystem (${error.fsType}), and SQLite needs a local disk.`,
      "Run `dipo daemon stop`, move the state directory to a local disk (set DIPO_HOME to a local directory), then start the daemon again.",
    );
  }
  if (error instanceof DatabaseTooNewError) {
    return failure(
      "tooNew",
      `The state database is at schema version ${error.found}, newer than this dipo supports (${error.supported}).`,
      "Upgrade dipo, then run `dipo daemon restart`.",
    );
  }
  const backup = newestBackup(stateDir);
  const restore = restoreSteps(stateDir, backup);
  const cause = error instanceof MigrationFailedError ? error.cause : error;
  if (isDamage(cause)) {
    return failure(
      "damaged",
      `The state database is damaged (${messageOf(cause)}).`,
      restore,
      backup,
    );
  }
  if (error instanceof MigrationFailedError) {
    const dir = backupsDirectory(join(stateDir, "dipo.db"));
    const suspect =
      backup === null
        ? `Move dipo.db away only if it is itself suspect; ${dir} holds no backup.`
        : `Copy the backup ${backup} over dipo.db, after deleting dipo.db-wal and dipo.db-shm, only if dipo.db itself is suspect.`;
    return failure(
      "migration",
      `Migration ${error.version} of the state database failed and was rolled back (${messageOf(error.cause)}), so dipo.db was left as it was.`,
      `This dipo cannot migrate it: run \`dipo daemon stop\`, then go back to the previous dipo version or upgrade to a release with a fixed migration, and start the daemon again. ${suspect}`,
      backup,
    );
  }
  if (error instanceof MigrationChecksumError) {
    return failure(
      "checksum",
      `${error.message} A released migration was edited.`,
      restore,
      backup,
    );
  }
  return failure(
    "open",
    `The state database could not be opened (${messageOf(error)}).`,
    restore,
    backup,
  );
}
