// The backups directory (0007): `<state>/backups/pre-v<N>-<yyyymmddThhmmss>.db`, written before each
// migration. It is the only backup; the two newest are kept.

import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { BACKUPS_DIR } from "../platform/sqlite";

/** How many pre-migration copies are kept (0007). */
export const PRE_MIGRATION_KEPT = 2;

const PRE_MIGRATION = /^pre-v(\d+)-(\d{8}T\d{6})(?:-(\d+))?\.db$/;
/** A daily copy an earlier dipo wrote, with its `.partial` while it was written. */
const DAILY = /^dipo-\d{8}\.db(?:\.partial)?$/;

/** `<state>/backups` for the database at `dbPath`. */
export function backupsDirectory(dbPath: string): string {
  return join(dirname(dbPath), BACKUPS_DIR);
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
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

/**
 * Deletes the daily copies an earlier dipo wrote (`dipo-<yyyymmdd>.db`): they hold prompts and
 * commands, which 0007 keeps no longer than the retention period, and the pre-migration copy is
 * the only backup now. Returns the names it deleted.
 */
export function removeDailyBackups(dir: string): string[] {
  const removed = list(dir).filter((name) => DAILY.test(name));
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

/**
 * Deletes the pre-migration copies beyond the newest `kept`; returns the names it deleted. A name
 * in `keep`, such as the copy just written, is never deleted, even when a clock that went back made
 * it look oldest; it takes its place in the count.
 */
export function prunePreMigrationBackups(
  dir: string,
  keep: ReadonlySet<string> = new Set(),
  kept: number = PRE_MIGRATION_KEPT,
): string[] {
  const names = preMigrationBackups(dir);
  const pinned = names.filter((name) => keep.has(name)).length;
  const removed = names.filter((name) => !keep.has(name)).slice(Math.max(0, kept - pinned));
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
