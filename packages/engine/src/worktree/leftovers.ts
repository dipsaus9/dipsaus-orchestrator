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
// `dipo <run-id>` the claim of an earlier binary gave it. Any other worktree there, such as one the
// maintainer added, is not touched. A worktree whose folder is gone is reconcile's notice
// (`goneWorktrees`), not this one's.
//
// Clean means: on a branch (not a detached HEAD), and `git status` listing no change, untracked
// file or ignored file other than a rebuildable one (`worktree.rebuildable` in the office
// configuration, DIPO-375: by default a whole `node_modules/` folder, a `.DS_Store` file and the
// build caches `.tsbuild/` and `.claude/.cc-writes/`). `git worktree remove` deletes those even
// without `--force`, and an install, a build or the Finder makes them again. The branch stays in
// either case, so no commit is lost.
//
// Saved means: on a branch, and every path `git status` lists (but the rebuildable ones) is a
// deleted file, or a regular file whose bytes equal the blob git holds for that path at some commit
// reachable from the branch tip. A worktree of a box run lags its branch, because the box's parts
// were committed from objects; its files are then saved, and removing it loses nothing. It is
// removed with `--force`, which git needs for a worktree with changes. Any other path keeps it.
//
// The desk rows are kept in `leftover_worktrees`, written again at each office load: a row whose
// worktree is gone or removed goes.

import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import { gitBlobId } from "../context/pack";
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

/**
 * Whether an ignored path `git status` lists is one of the `rebuildable` entries of the office
 * configuration. An entry without a slash names a file or folder at any depth (a trailing `/`
 * makes it a folder only); an entry with a slash names one exact path from the worktree root.
 */
export function isRebuildable(path: string, rebuildable: readonly string[]): boolean {
  const folder = path.endsWith("/");
  const bare = path.replace(/\/$/, "");
  return rebuildable.some((entry) => {
    const name = entry.replace(/\/$/, "");
    if (name.includes("/")) return bare === name;
    return basename(bare) === name && (folder || !entry.endsWith("/"));
  });
}

/** How many paths a kept worktree's detail names; the rest are counted. */
const SHOWN_PATHS = 10;

/** How many changed paths dipo checks against git; a worktree with more is kept unchecked. */
const CHECKED_PATHS = 500;

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

/** A path `git status` lists, and whether the worktree lacks the file (a deletion). */
export interface StatusPath {
  readonly path: string;
  readonly deleted: boolean;
}

/**
 * The paths `git status --porcelain=v1 -z` lists that keep a worktree unless saved: every change
 * and untracked path, and every ignored path but a `rebuildable` one. A rename's second path is
 * skipped.
 */
export function statusPaths(status: string, rebuildable: readonly string[]): StatusPath[] {
  const fields = status.split("\0");
  const paths: StatusPath[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
    if (code === "!!" && isRebuildable(path, rebuildable)) continue;
    paths.push({ path, deleted: code[1] === "D" || (code[0] === "D" && code[1] === " ") });
  }
  return paths;
}

/** The paths of `statusPaths`. */
export function keepingPaths(status: string, rebuildable: readonly string[]): string[] {
  return statusPaths(status, rebuildable).map((entry) => entry.path);
}

/**
 * The `<path>\0<blob>` pairs of `git log --raw -z` output: each blob a commit gave a path, and the
 * one it replaced.
 */
export function heldBlobs(raw: string): Set<string> {
  const held = new Set<string>();
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const meta = (fields[i] ?? "").replace(/^\n+/, "");
    if (!meta.startsWith(":")) continue;
    const path = fields[i + 1] ?? "";
    i += 1;
    const [, , before, after] = meta.slice(1).split(" ");
    if (before !== undefined) held.add(`${path}\0${before}`);
    if (after !== undefined) held.add(`${path}\0${after}`);
  }
  return held;
}

/**
 * The paths of `paths` whose files in the worktree at `root` are not saved: not a regular file, or
 * bytes git holds for that path at no commit reachable from `tip`. A deleted file is saved.
 */
async function unsavedPaths(
  session: GitSession,
  root: string,
  tip: string,
  paths: readonly StatusPath[],
): Promise<string[]> {
  const unsaved: string[] = [];
  const blobs = new Map<string, string>();
  for (const { path, deleted } of paths) {
    if (deleted) continue;
    const file = join(root, path);
    try {
      if (!lstatSync(file).isFile()) {
        unsaved.push(path);
        continue;
      }
      blobs.set(path, gitBlobId(readFileSync(file)));
    } catch {
      unsaved.push(path);
    }
  }
  if (blobs.size === 0) return unsaved;
  const raw = await session.ok(session.repository, [
    "log",
    "--no-abbrev",
    "--raw",
    "-z",
    "--no-renames",
    "--format=",
    tip,
    "--",
    ...[...blobs.keys()].map((path) => `:(literal)${path}`),
  ]);
  const held = heldBlobs(raw);
  for (const [path, blob] of blobs) if (!held.has(`${path}\0${blob}`)) unsaved.push(path);
  return unsaved;
}

/** What to do with a leftover: keep it and why, or remove it (`saved`: with `--force`). */
type LeftoverVerdict = { readonly keep: string } | { readonly remove: "clean" | "saved" };

/** Whether to keep or remove the worktree (see the file comment). */
async function verdictOf(
  git: OfficeGit,
  session: GitSession,
  entry: ListedWorktree,
  rebuildable: readonly string[],
): Promise<LeftoverVerdict> {
  if (entry.branch === null) return { keep: "it has a detached HEAD checked out" };
  let paths: StatusPath[];
  let unsaved: string[];
  try {
    const status = await session.ok(
      git.worktreeLocation(entry.path),
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV },
    );
    paths = statusPaths(status, rebuildable);
    if (paths.length === 0) return { remove: "clean" };
    if (paths.length > CHECKED_PATHS) {
      unsaved = paths.map((p) => p.path);
    } else {
      const tip = (
        await session.ok(session.repository, ["rev-parse", "--verify", `${entry.branch}^{commit}`])
      ).trim();
      unsaved = await unsavedPaths(session, entry.path, tip, paths);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { keep: `dipo could not check its files (${why})` };
  }
  if (unsaved.length === 0) return { remove: "saved" };
  const shown = unsaved.slice(0, SHOWN_PATHS).join(", ");
  const more = unsaved.length > SHOWN_PATHS ? ` and ${unsaved.length - SHOWN_PATHS} more` : "";
  return {
    keep: `it holds changes, untracked or ignored files git does not hold: ${shown}${more}`,
  };
}

/**
 * Removes the clean leftover story worktrees of the office and keeps the others, in one item of
 * the office git queue (see the file comment). A worktree git refuses to remove is kept, with
 * git's reason.
 */
export function sweepLeftoverWorktrees(
  git: OfficeGit,
  rebuildable: readonly string[],
): Promise<LeftoverSweep> {
  return git.run(async (session) => {
    const listed = parseWorktreeList(
      await session.ok(session.repository, ["worktree", "list", "--porcelain", "-z"]),
    );
    const removed: string[] = [];
    const kept: KeptWorktree[] = [];
    for (const entry of leftoverCandidates(listed, git.worktreeRoot())) {
      const branch = entry.branch?.replace(/^refs\/heads\//, "") ?? null;
      const verdict = await verdictOf(git, session, entry, rebuildable);
      if ("keep" in verdict) {
        kept.push({ path: entry.path, branch, why: verdict.keep });
        continue;
      }
      const force = verdict.remove === "saved";
      const result = await removeLeftoverWorktree(session, entry.path, entry.locked, force).catch(
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
