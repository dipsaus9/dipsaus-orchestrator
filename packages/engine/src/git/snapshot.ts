// The run-start snapshot of a story worktree's git links (0008 section 2, "Engine git calls"):
// the administrative directory `<common-dir>/worktrees/<name>`, the contents of its `commondir` and
// `gitdir` files, and the worktree's `.git` pointer file. The engine records it at the claim and,
// before every later git call in that worktree, compares the files with it; a worker that rewrote
// one of them to point git at a config with `core.fsmonitor` or `core.hooksPath` gets no engine
// git call there (`git.worktreeTampered`).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GitError } from "./runner";

export interface WorktreeSnapshot {
  /** The worktree, canonical, as the engine created it. */
  readonly path: string;
  /** `<common-dir>/worktrees/<name>`, the worktree's `GIT_DIR`. */
  readonly adminDir: string;
  /** The exact contents of `<adminDir>/commondir`. */
  readonly commondir: string;
  /** The exact contents of `<adminDir>/gitdir`. */
  readonly gitdir: string;
  /** The exact contents of `<path>/.git`. */
  readonly pointer: string;
}

/** The three links the snapshot covers, by name. */
export type SnapshotLink = "commondir" | "gitdir" | "pointer";

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Reads the links of the worktree at `path` with the administrative directory `adminDir`. */
export function readWorktreeSnapshot(path: string, adminDir: string): WorktreeSnapshot {
  const commondir = readOrNull(join(adminDir, "commondir"));
  const gitdir = readOrNull(join(adminDir, "gitdir"));
  const pointer = readOrNull(join(path, ".git"));
  if (commondir === null || gitdir === null || pointer === null) {
    throw new GitError(
      "git.failed",
      `The worktree ${path} has no complete set of git links (${adminDir}/commondir, ${adminDir}/gitdir, ${path}/.git); dipo cannot record its snapshot.`,
      false,
      { path, adminDir },
    );
  }
  return { path, adminDir, commondir, gitdir, pointer };
}

/** The links that no longer match `snapshot`, in a fixed order; empty when all match. */
export function changedLinks(snapshot: WorktreeSnapshot): SnapshotLink[] {
  const changed: SnapshotLink[] = [];
  if (readOrNull(join(snapshot.adminDir, "commondir")) !== snapshot.commondir) {
    changed.push("commondir");
  }
  if (readOrNull(join(snapshot.adminDir, "gitdir")) !== snapshot.gitdir) changed.push("gitdir");
  if (readOrNull(join(snapshot.path, ".git")) !== snapshot.pointer) changed.push("pointer");
  return changed;
}

/** The refusal of a git call in a worktree whose links changed since its snapshot. */
export function worktreeTampered(
  snapshot: WorktreeSnapshot,
  changed: readonly SnapshotLink[],
): GitError {
  const files = changed.map((link) =>
    link === "pointer" ? `${snapshot.path}/.git` : `${snapshot.adminDir}/${link}`,
  );
  return new GitError(
    "git.worktreeTampered",
    `The git links of ${snapshot.path} changed since dipo claimed it (${files.join(", ")}); dipo runs no git in that worktree.`,
    false,
    { path: snapshot.path, adminDir: snapshot.adminDir, changed: [...changed] },
  );
}
