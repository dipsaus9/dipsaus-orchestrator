// The daily backup (0007 section 10): `VACUUM INTO <state>/backups/dipo-<yyyymmdd>.db` from a Bun
// Worker with its own read-only connection, then `PRAGMA quick_check` on the copy in that Worker
// (`vacuumInto` of the platform module). The copy is written under a `.partial` name and renamed
// only after the check passed, so a file named like a backup always passed it. Then the copies
// beyond the counts to keep are deleted.

import { existsSync, renameSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { vacuumInto } from "../platform/sqlite";

import {
  type BackupCounts,
  backupsDirectory,
  dailyBackupName,
  DEFAULT_BACKUP_COUNTS,
  pruneBackups,
} from "./files";

export type VacuumInto = typeof vacuumInto;

export interface DailyBackupOptions {
  /** Absolute path of `dipo.db`. */
  readonly dbPath: string;
  /** The time of the backup; it names the file and becomes its mtime. */
  readonly now: number;
  readonly counts?: BackupCounts;
  /** Replaces the Worker snapshot, for tests. */
  readonly vacuum?: VacuumInto;
}

export interface DailyBackupResult {
  readonly path: string;
  /** False when today's copy already existed. */
  readonly written: boolean;
  /** Older copies deleted after this one was written. */
  readonly removed: readonly string[];
}

/** Writes today's copy unless it exists, checks it, and prunes older copies. */
export async function writeDailyBackup(options: DailyBackupOptions): Promise<DailyBackupResult> {
  const dir = backupsDirectory(options.dbPath);
  const path = join(dir, dailyBackupName(options.now));
  if (existsSync(path)) return { path, written: false, removed: [] };
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  try {
    await (options.vacuum ?? vacuumInto)(options.dbPath, partial, { quickCheck: true });
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, path);
  // The engine's clock decides when the next copy is due, so the copy carries its time.
  const seconds = options.now / 1000;
  utimesSync(path, seconds, seconds);
  const removed = pruneBackups(dir, options.counts ?? DEFAULT_BACKUP_COUNTS);
  return { path, written: true, removed };
}
