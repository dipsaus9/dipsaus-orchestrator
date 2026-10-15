// Leftover branch-read scratch directories (DIPO-90). `readOnBranch` makes
// `<worktree root>/_branch-read-*` and removes it in a `finally`, so a daemon killed or crashed
// mid-read leaves it behind. When an office loads, the claims load step removes every such
// directory older than the daemon start, before the story index runs any branch read; a scratch
// directory this daemon made is never older than its start.
//
// The sweep only ever removes a direct child of the worktree root whose name starts with
// `BRANCH_READ_PREFIX`, that is a real directory (a symbolic link is never followed or removed)
// and that holds no `.git` (a claim worktree or `_base` never matches). The recursive removal
// unlinks symbolic links inside the scratch directory without following them.

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { BRANCH_READ_PREFIX } from "../stories/branch-read";

export interface BranchReadSweep {
  /** The scratch directories removed. */
  readonly removed: readonly string[];
  /** The scratch directories that could not be removed, with the reason. */
  readonly failed: readonly { readonly path: string; readonly error: string }[];
}

/**
 * The margin before the daemon start: a scratch directory must be at least this much older than
 * the start to be swept, for coarse filesystem timestamps and clock skew.
 */
export const SWEEP_MARGIN_MS = 5_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes every `<root>/_branch-read-*` directory last modified more than `SWEEP_MARGIN_MS`
 * before `startedAt` (wall-clock epoch ms, compared with file mtimes). A missing root sweeps
 * nothing; a root that cannot be listed (not a directory, no permission) is reported in `failed`.
 */
export function sweepBranchReads(root: string, startedAt: number): BranchReadSweep {
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  if (!existsSync(root)) return { removed, failed };
  const before = startedAt - SWEEP_MARGIN_MS;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    failed.push({ path: root, error: message(error) });
    return { removed, failed };
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(BRANCH_READ_PREFIX) || !entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.mtimeMs >= before) continue;
      if (existsSync(join(path, ".git"))) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: message(error) });
    }
  }
  return { removed, failed };
}
