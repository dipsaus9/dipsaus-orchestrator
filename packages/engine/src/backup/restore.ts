// Restore (0007 section 10; offline maintenance of the 0006 amendment of 2026-10-12): replaces
// `<state>/dipo.db` with a backup while no daemon runs. The backup is copied next to `dipo.db`
// first, so the backup file itself is never opened or changed. On that copy restore runs
// `PRAGMA quick_check`, checks that it is a dipo state database this binary can migrate, and writes
// a new random epoch into every `offices` row, so every client cursor of the old file gets
// `stream.resetRequired` (0005 section 8). Then it closes its connection, deletes the live
// `dipo.db-wal` and `dipo.db-shm` (they belong to the old file and would be replayed into the new
// one), and renames the copy over `dipo.db`. The next daemon start migrates the file if it is
// older and reconciles each office with Backlog.md and git (DIPO-56).

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { OfficeId } from "@dipsaus-orchestrator/contract";

import { newEpoch } from "../changelog/log";
import type { Migration } from "../db/migrations";
import { MIGRATIONS } from "../db/schema";
import type { RandomFill } from "../platform/ids";
import { DATABASE_FILE, openSqliteFile, type SqliteFile } from "../platform/sqlite";

/** The copy of the backup that restore prepares before it replaces `dipo.db`. */
export const RESTORE_FILE = `${DATABASE_FILE}.restore`;

/** The live file's sidecars that restore deletes before the rename (0007 section 10). */
export const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface RestoreOptions {
  /** The software state directory `<state>` that holds `dipo.db`. */
  readonly stateDir: string;
  /** Absolute path of the backup to restore. */
  readonly file: string;
  /** Randomness for the new epochs; tests pass a fixed one. */
  readonly fill?: RandomFill;
  /** The migrations this binary knows; a backup with a newer schema is refused. */
  readonly migrations?: readonly Migration[];
}

export interface RestoreResult {
  /** Absolute path of the replaced `dipo.db`. */
  readonly path: string;
  /** Every office in the restored file, each with a new epoch, forgotten ones included. */
  readonly offices: readonly OfficeId[];
  /** The newest migration the backup had applied; the next daemon start migrates from there. */
  readonly schemaVersion: number;
  /** The live sidecar files restore deleted. */
  readonly removed: readonly string[];
}

/** Restore refused or failed; the live `dipo.db` is unchanged. */
export class BackupRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupRestoreError";
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeCopy(temp: string): void {
  for (const suffix of ["", "-journal", ...SIDECAR_SUFFIXES])
    rmSync(`${temp}${suffix}`, { force: true });
}

/** Opens the copy, checks it and writes the new epochs; returns what it found. */
function prepare(
  temp: string,
  file: string,
  options: RestoreOptions,
): { offices: OfficeId[]; schemaVersion: number } {
  let db: SqliteFile;
  try {
    db = openSqliteFile(temp);
  } catch (error) {
    throw new BackupRestoreError(`${file} is not a SQLite database: ${reasonOf(error)}.`);
  }
  try {
    let problems: string[];
    try {
      problems = db.quickCheck();
    } catch (error) {
      problems = [reasonOf(error)];
    }
    if (problems.length > 0) {
      throw new BackupRestoreError(
        `${file} failed its integrity check (PRAGMA quick_check): ${problems.slice(0, 3).join("; ")}. Pick another backup.`,
      );
    }
    const tables = new Set(
      db
        .all<{ name: string }>("select name from sqlite_schema where type = 'table'")
        .map((row) => row.name),
    );
    if (!tables.has("offices") || !tables.has("schema_migrations")) {
      throw new BackupRestoreError(
        `${file} is not a dipo state database (it has no offices table).`,
      );
    }
    const schemaVersion =
      db.get<{ v: number | null }>("select max(version) as v from schema_migrations")?.v ?? 0;
    const newest = Math.max(0, ...(options.migrations ?? MIGRATIONS).map((step) => step.version));
    if (schemaVersion > newest) {
      throw new BackupRestoreError(
        `${file} has schema version ${schemaVersion}, newer than this dipo knows (${newest}); restore it with the dipo that wrote it.`,
      );
    }
    const offices = db.immediate(() => {
      const ids = db
        .all<{ office_id: string }>("select office_id from offices order by added_at, office_id")
        .map((row) => OfficeId.parse(row.office_id));
      for (const office of ids) {
        db.run("update offices set epoch = $epoch where office_id = $office", {
          office,
          epoch: newEpoch(options.fill),
        });
      }
      return ids;
    });
    return { offices, schemaVersion };
  } finally {
    db.close();
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `<state>/dipo.db` with the backup at `file`. The caller holds the daemon lock, so no
 * daemon has the file open. Throws `BackupRestoreError`, with `dipo.db` unchanged, when the backup is
 * missing, damaged, not a dipo state database or newer than this binary.
 */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  const { stateDir, file } = options;
  const live = join(stateDir, DATABASE_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new BackupRestoreError(`${file} does not exist or is not a file.`);
  }
  if (existsSync(live) && realpathSync(file) === realpathSync(live)) {
    throw new BackupRestoreError(`${file} is the live database; name a backup to restore.`);
  }
  mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });

  const temp = join(stateDir, RESTORE_FILE);
  removeCopy(temp);
  try {
    copyFileSync(file, temp);
    chmodSync(temp, FILE_MODE);
    const { offices, schemaVersion } = prepare(temp, file, options);
    // The connection is closed: drop the old file's WAL and shared memory, then swap the file.
    const removed: string[] = [];
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${live}${suffix}`;
      if (existsSync(sidecar)) {
        rmSync(sidecar, { force: true });
        removed.push(sidecar);
      }
    }
    renameSync(temp, live);
    syncDirectory(stateDir);
    return { path: live, offices, schemaVersion, removed };
  } catch (error) {
    removeCopy(temp);
    throw error;
  }
}
