// Story worktrees an earlier binary left behind (DIPO-349; 0010). A story has no worktree any more:
// its claim is its branch, and its code is in its box. Earlier binaries made a locked worktree per
// claimed story at `<worktree root>/<ID>`. When an office loads, the claims load step looks for
// them and:
//
// - removes a clean one with `git worktree remove` through the git module, without `--force`
//   (`removeLeftoverWorktree`), so git itself refuses one that changed meanwhile;
// - keeps a dirty one and lists it on the desk (`LEFTOVER WORKTREE`, `leftoverWorktreeDeskItems`),
//   with what keeps it, for the maintainer to save or remove by hand. dipo never deletes it.
//
// Only a worktree dipo made is a candidate: one git lists directly under the worktree root, not
// named with a leading `_` like dipo's own `_base` and `_backlog`, and locked with the reason
// `dipo <run-id>` the claim of an earlier binary gave it. Any other worktree there, such as one the maintainer added, is not
// touched. A worktree whose folder is gone is reconcile's notice (`goneWorktrees`), not this one's.
//
// Clean means: on a branch (not a detached HEAD), its `.git` pointing at its registered folder,
// and `git status` listing no change, untracked file or ignored file other than a whole
// `node_modules/` folder or a `.DS_Store` file (which `git worktree remove` deletes even without
// `--force`, and which an install or the Finder makes again). The branch stays in either case, so
// no commit is lost.
//
// The desk rows are kept in `leftover_worktrees`, written again at each office load: a row whose
// worktree is gone or removed goes.

import { basename, dirname } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { canonicalFuturePath } from "../git/paths";
import { removeLeftoverWorktree } from "../git/write";
import { type ListedWorktree, parseWorktreeList } from "../reconcile/git-facts";

/** The desk kind of a leftover worktree dipo kept (0020 section 12). */
export const LEFTOVER_WORKTREE_DESK = "LEFTOVER WORKTREE";

/** The lock reason a claim of an earlier binary gave its story worktree: `dipo <run-id>`. */
const CLAIM_LOCK = /^dipo run_[0-9A-Za-z]+$/;

/** Ignored entries `git worktree remove` may delete with a leftover: rebuilt by an install or the Finder. */
function rebuildable(path: string): boolean {
  const name = path.replace(/\/$/, "");
  return (
    (path.endsWith("/") && basename(name) === "node_modules") || basename(name) === ".DS_Store"
  );
}

/** How many paths a kept worktree's detail names; the rest are counted. */
const SHOWN_PATHS = 10;

/** A leftover worktree dipo kept, and why. */
export interface KeptWorktree {
  readonly path: string;
  /** The branch it has checked out (`<ID>/<slug>`), or null for a detached HEAD. */
  readonly branch: string | null;
  /** Why it was kept: the changes git lists, or why dipo could not check it. */
  readonly why: string;
}

/** What one sweep did. */
export interface LeftoverSweep {
  readonly removed: readonly string[];
  readonly kept: readonly KeptWorktree[];
}

/** The leftover story worktrees git lists under `root` (see the file comment). */
export function leftoverCandidates(
  worktrees: readonly ListedWorktree[],
  root: string,
): ListedWorktree[] {
  const canonicalRoot = canonicalFuturePath(root);
  return worktrees.filter(
    (entry) =>
      dirname(entry.path) === canonicalRoot &&
      !basename(entry.path).startsWith("_") &&
      entry.prunable === null &&
      entry.locked !== null &&
      CLAIM_LOCK.test(entry.locked),
  );
}

/**
 * The paths `git status --porcelain=v1 -z` lists that keep a worktree: every change and untracked
 * path, and every ignored path but a rebuildable one. A rename's second path is skipped.
 */
export function keepingPaths(status: string): string[] {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
    if (code === "!!" && rebuildable(path)) continue;
    paths.push(path);
  }
  return paths;
}

/** Why the worktree must be kept, or null when it is clean (see the file comment). */
async function keepReason(
  git: OfficeGit,
  session: GitSession,
  entry: ListedWorktree,
): Promise<string | null> {
  if (entry.branch === null) return "it has a detached HEAD checked out";
  let status: string;
  try {
    status = await session.ok(
      git.worktreeLocation(entry.path),
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV },
    );
  } catch (error) {
    return `dipo could not read its status (${error instanceof Error ? error.message : String(error)})`;
  }
  const paths = keepingPaths(status);
  if (paths.length === 0) return null;
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  const more = paths.length > SHOWN_PATHS ? ` and ${paths.length - SHOWN_PATHS} more` : "";
  return `it holds changes, untracked or ignored files: ${shown}${more}`;
}

/**
 * Removes the clean leftover story worktrees of the office and keeps the others, in one item of
 * the office git queue (see the file comment). A worktree git refuses to remove is kept, with
 * git's reason.
 */
export function sweepLeftoverWorktrees(git: OfficeGit): Promise<LeftoverSweep> {
  return git.run(async (session) => {
    const listed = parseWorktreeList(
      await session.ok(session.repository, ["worktree", "list", "--porcelain", "-z"]),
    );
    const removed: string[] = [];
    const kept: KeptWorktree[] = [];
    for (const entry of leftoverCandidates(listed, git.worktreeRoot())) {
      const branch = entry.branch?.replace(/^refs\/heads\//, "") ?? null;
      const why = await keepReason(git, session, entry);
      if (why !== null) {
        kept.push({ path: entry.path, branch, why });
        continue;
      }
      const result = await removeLeftoverWorktree(session, entry.path, entry.locked).catch(
        (error: unknown) => ({
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }),
      );
      if (result.code === 0) {
        removed.push(entry.path);
      } else {
        const reason = result.stderr.trim() || `exit ${result.code}`;
        kept.push({ path: entry.path, branch, why: `git refused to remove it (${reason})` });
      }
    }
    return { removed, kept };
  });
}

/** Writes the kept leftovers as the office's desk rows, replacing the rows of the last sweep. */
export function recordKeptWorktrees(
  office: OfficeHandle,
  kept: readonly KeptWorktree[],
  clock: Clock,
): void {
  const at = clock.now();
  office.immediate(() => {
    const before = new Map(
      office
        .all<{ path: string; found_at: number }>(
          "select path, found_at from leftover_worktrees where office_id = $office_id",
        )
        .map((row) => [row.path, row.found_at]),
    );
    office.run("delete from leftover_worktrees where office_id = $office_id");
    for (const worktree of kept) {
      office.run(
        `insert into leftover_worktrees (office_id, path, branch, why, found_at)
         values ($office_id, $path, $branch, $why, $at)`,
        {
          path: worktree.path,
          branch: worktree.branch,
          why: worktree.why,
          at: before.get(worktree.path) ?? at,
        },
      );
    }
  });
}

/** One LEFTOVER WORKTREE desk item: an office item with no story. */
export interface LeftoverWorktreeDeskItem {
  readonly kind: typeof LEFTOVER_WORKTREE_DESK;
  readonly detail: string;
  readonly since: number;
  /** What the maintainer does by hand: no dipo command removes a kept worktree. */
  readonly hand: string;
}

/** The office's kept leftover worktrees as desk items, oldest first. */
export function leftoverWorktreeDeskItems(office: OfficeHandle): LeftoverWorktreeDeskItem[] {
  return office
    .all<{ path: string; branch: string | null; why: string; found_at: number }>(
      `select path, branch, why, found_at from leftover_worktrees where office_id = $office_id
       order by found_at, path`,
    )
    .map((row) => ({
      kind: LEFTOVER_WORKTREE_DESK,
      detail: `${row.path}${row.branch === null ? "" : ` (${row.branch})`} · ${row.why}`,
      since: row.found_at,
      hand: `save what you need from ${row.path}, then remove it by hand (\`git worktree unlock ${row.path}\`, then \`git worktree remove --force ${row.path}\`); its branch stays`,
    }));
}
