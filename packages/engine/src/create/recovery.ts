// Recovery steps (0006 decision 7, 0007 section 1). In `recovering` the engine runs the steps it
// lists, in their one order, with the database migrations always first; then it
// enters `running`, or `safe` when the crash counter says so. Reconcile (DIPO-56) and re-attach
// (DIPO-57) plug in here. A drain that starts during recovery lets the current step finish and runs
// no further step.
//
// A state database that cannot be opened or migrated (0007 sections 9 and 10, DIPO-111) does not
// stop the daemon: the migrations step holds it in `recovering` with a `DatabaseFailure` from
// `databaseFailure` below, no further step runs, and the daemon serves software commands until it
// is stopped. Exiting instead would make a supervisor restart it in a loop, and every start would
// write another pre-migration backup.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Clock, DatabaseUnavailableReason } from "@dipsaus-orchestrator/contract";
import { backupsDirectory, dailyBackups, preMigrationBackups } from "../backup/files";
import type { StateDatabase } from "../db/database";
import {
  DatabaseTooNewError,
  MigrationChecksumError,
  MigrationFailedError,
} from "../db/migrations";
import type { Logger } from "../log/logger";
import type { ChildProcesses } from "../platform/process";
import { IntegrityCheckError, NetworkFileSystemError } from "../platform/sqlite";

import { CRASH_LOOP_REASON, type DaemonLifecycle, type DatabaseFailure } from "./lifecycle";

export interface RecoveryContext {
  readonly logger: Logger;
  readonly clock: Clock;
  /** Child processes a step starts go through here, so the drain waits for them. */
  readonly children: ChildProcesses;
  /** The migrated state database; throws when called before the migrations step has run. */
  database(): StateDatabase;
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
  /** True when the crash counter requires `safe` (0006 decision 7). */
  readonly crashLoop: boolean;
}

/**
 * Moves `starting` to `recovering`, runs every step, then enters `running` or `safe`. Resolves to
 * false when a drain began before recovery finished, or when a step held the daemon in
 * `recovering` because the state database is unavailable; a failing step rejects.
 */
export async function runRecovery(options: RunRecoveryOptions): Promise<boolean> {
  const { lifecycle, steps, context, crashLoop } = options;
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
  if (crashLoop) lifecycle.transition("safe", CRASH_LOOP_REASON);
  else lifecycle.transition("running", "recovered");
  return true;
}

/** A failed `quick_check`, or SQLite finding the file damaged or no database at all. */
function isDamage(error: unknown): boolean {
  if (error instanceof IntegrityCheckError) return true;
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
 * The newest backup in `<state>/backups` that holds a schema (0007 section 10), daily or
 * pre-migration, by modification time; null when there is none. A pre-migration copy of a database
 * that was still empty has `user_version` 0 and restores nothing, so it is never named.
 */
export function newestBackup(stateDir: string): string | null {
  const dir = backupsDirectory(join(stateDir, "dipo.db"));
  let newest: { path: string; at: number } | null = null;
  for (const name of [...dailyBackups(dir), ...preMigrationBackups(dir)]) {
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

/** The `dipo daemon stop`, then `dipo restore` instruction, naming the backup when one exists. */
function restoreSteps(stateDir: string, backup: string | null): string {
  if (backup !== null) return `Run \`dipo daemon stop\`, then \`dipo restore ${backup}\`.`;
  const dir = backupsDirectory(join(stateDir, "dipo.db"));
  return `Run \`dipo daemon stop\`, then \`dipo restore <file>\` with a copy of dipo.db; ${dir} holds no backup.`;
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

/** What the damage is: the first `quick_check` problems, or the SQLite message. */
function damageOf(error: unknown): string {
  if (error instanceof IntegrityCheckError) {
    return `PRAGMA quick_check reported: ${error.problems.slice(0, 3).join("; ")}`;
  }
  return messageOf(error);
}

/**
 * What a failed open or migration of the state database means for the maintainer (0007 sections 9
 * and 10, DIPO-111): the reason, the newest backup when the fix is a restore, and one paragraph
 * that says what to do. A failed migration left `dipo.db` as it was (the step rolled back), so the
 * fix is a dipo whose migrations work: the previous version or a fixed release; the backup is for
 * a file that is itself suspect. An edited migration, a damaged file or any other failure: stop
 * the daemon and restore the newest backup. A too-new database: upgrade dipo. A network
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
      `The state database is damaged (${damageOf(cause)}).`,
      restore,
      backup,
    );
  }
  if (error instanceof MigrationFailedError) {
    const dir = backupsDirectory(join(stateDir, "dipo.db"));
    const suspect =
      backup === null
        ? `Restore a backup only if dipo.db itself is suspect; ${dir} holds none.`
        : `Restore the backup only if dipo.db itself is suspect: \`dipo restore ${backup}\`.`;
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

/**
 * Whether the next open must run quick_check after a failed open (DIPO-111): always after damage,
 * and after a failure that came before the check could pass (a network filesystem or any other
 * open failure) when this open had to check. A too-new database, a failed or an edited migration
 * fail after quick_check passed, so they clear it; without a check they leave it unset. The rule is
 * deliberately conservative: any other open failure while a check was due keeps the flag, even when
 * quick_check may have run and passed, because the open cannot tell; one extra check at the next
 * start costs little.
 */
export function needsCheckAfter(reason: string, checked: boolean): boolean {
  if (reason === "damaged") return true;
  if (!checked) return false;
  return reason !== "tooNew" && reason !== "migration" && reason !== "checksum";
}
