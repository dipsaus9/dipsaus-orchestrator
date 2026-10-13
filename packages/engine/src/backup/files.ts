// The backups directory (0007 sections 2 and 10): `<state>/backups/dipo-<yyyymmdd>.db` daily and
// `pre-v<N>-<yyyymmddThhmmss>.db` before each migration. The daily job keeps the 3 newest daily
// copies and the 2 newest pre-migration copies and deletes the rest.

import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { BACKUPS_DIR } from "../platform/sqlite";

/** How many copies of each kind are kept (0007 open question 6). */
export interface BackupCounts {
  readonly daily: number;
  readonly preMigration: number;
}

export const DEFAULT_BACKUP_COUNTS: BackupCounts = { daily: 3, preMigration: 2 };

const DAILY = /^dipo-(\d{8})\.db$/;
const PRE_MIGRATION = /^pre-v(\d+)-(\d{8}T\d{6})(?:-(\d+))?\.db$/;

/** `<state>/backups` for the database at `dbPath`. */
export function backupsDirectory(dbPath: string): string {
  return join(dirname(dbPath), BACKUPS_DIR);
}

/** `yyyymmdd` of `ms` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
}

/** `dipo-<yyyymmdd>.db` for the UTC day of `ms`. */
export function dailyBackupName(ms: number): string {
  return `dipo-${utcDay(ms)}.db`;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

/** The daily copies, newest day first. */
export function dailyBackups(dir: string): string[] {
  return list(dir)
    .filter((name) => DAILY.test(name))
    .toSorted()
    .toReversed();
}

function preMigrationKey(name: string): { stamp: string; n: number; version: number } {
  const match = PRE_MIGRATION.exec(name);
  return {
    stamp: match?.[2] ?? "",
    n: Number(match?.[3] ?? 1),
    version: Number(match?.[1] ?? 0),
  };
}

/** The pre-migration copies, newest first: by time, then the `-<n>` suffix, then version. */
export function preMigrationBackups(dir: string): string[] {
  const key = preMigrationKey;
  return list(dir)
    .filter((name) => PRE_MIGRATION.test(name))
    .toSorted((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x.stamp !== y.stamp) return x.stamp < y.stamp ? 1 : -1;
      if (x.n !== y.n) return y.n - x.n;
      return y.version - x.version;
    });
}

/** When the newest daily copy was written (its mtime), or null when there is none. */
export function newestDailyBackupAt(dir: string): number | null {
  let newest: number | null = null;
  for (const name of dailyBackups(dir)) {
    const at = statSync(join(dir, name)).mtimeMs;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/** The names beyond `count`, newest first; names in `keep` are never removed and count first. */
function beyond(names: readonly string[], count: number, keep: ReadonlySet<string>): string[] {
  const kept = names.filter((name) => keep.has(name)).length;
  return names.filter((name) => !keep.has(name)).slice(Math.max(0, count - kept));
}

/**
 * Deletes the copies beyond the counts to keep; returns the names it deleted. Names in `keep`, such
 * as the copy just written, are never deleted, even when a clock that went back made them look
 * oldest; they take their place in the count.
 */
export function pruneBackups(
  dir: string,
  counts: BackupCounts = DEFAULT_BACKUP_COUNTS,
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const removed = [
    ...beyond(dailyBackups(dir), counts.daily, keep),
    ...beyond(preMigrationBackups(dir), counts.preMigration, keep),
  ];
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
