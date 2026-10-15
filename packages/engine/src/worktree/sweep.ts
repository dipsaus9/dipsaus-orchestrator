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
 * Removes every `<root>/_branch-read-*` directory last modified before `before` (epoch ms).
 * A missing root sweeps nothing.
 */
export function sweepBranchReads(root: string, before: number): BranchReadSweep {
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  if (!existsSync(root)) return { removed, failed };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(BRANCH_READ_PREFIX) || !entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.mtimeMs >= before) continue;
      if (existsSync(join(path, ".git"))) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}
