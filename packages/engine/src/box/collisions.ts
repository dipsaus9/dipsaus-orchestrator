// Changed files and collisions of box runs (0021 section 12 and maintainer decisions 1 and 20,
// DIPO-277). References are only the planner's forecast; what counts is what each story really
// changed, and two stories in progress that change the same files both continue.
//
// - Changed files. A story's changed files are the paths its delivered parts changed: the story
//   branch's tip against its start commit, read from git (`storyChangedFiles`), never from the
//   worker's own list. After a catch-up the branch holds the new base, so the start point is the
//   merge base of the tip and the base when the start commit lies below it. `backlog/` is left out:
//   only dipo writes it, never a part (`protectedKind`).
// - Overlaps. Every pass compares the changed files of the live box runs of each office with the
//   prefix rule (0012, 0010 section 10): two paths overlap when they are equal or one is a folder
//   above the other. A new overlap (another pair of stories, or more paths) is told to the maintainer
//   as an `engine.notice` (the TUI and `dipo watch` show it) and to both workers as a message.
// - Catching up. The second story catches up once the first has merged: when the base branch holds
//   changes, since the story's merge base, to files the story changed too. The check is git's own
//   merge (`git merge-tree --write-tree`, from git objects alone, no checkout, no model). Then, in
//   the run's turn of `BoxParts` (no part is taken in between), and after whatever the box holds was
//   delivered as a part, so the branch tip is the box's code:
//   1. dipo commits the merge from git objects (`commit-tree` with the tip and the base as parents);
//   2. it copies the merge into the box: the paths the merge changed against the tip, outside
//      `backlog/` (dipo's task-file commits never reach the box, `readView`), removed or written
//      from a `git archive` of the merge, as the box got its code (`stageBoxCode`);
//   3. only then the branch moves to the merge (`update-ref` from the tip read), and it is pushed
//      without force;
//   4. the maintainer gets a notice and the worker a message naming the files.
//   The box is written before the branch moves: a box that kept the old files while the branch held
//   the new ones would hand them back as the worker's next part and undo the merge. A box copy that
//   fails, or a branch that moved meanwhile, parks the story (`catch-up-failed`), since box and
//   branch may then differ.
// - A conflict starts a fix round. When git cannot merge cleanly the merge is committed with git's
//   conflict markers in the files it names, copied into the box the same way, and the worker is told
//   to resolve them and hand a part. Committing the markers keeps the box and the branch on the same
//   tree, so the worker's resolution is an ordinary part (scanned like any other); holding the base
//   back as a second parent of the next part instead would make the base's own changes look like
//   the worker's, and a base change to a protected file (`.github/`) would park the story. A
//   conflict inside `backlog/` is the maintainer's: dipo leaves the branch and the box alone and
//   tells only the maintainer, once per base commit.
//
// Every git call runs on the repository without a work tree through the office git queue, with the
// hardened config, hooks off and filters off (`filtersOffConfig`); none runs in a folder the worker
// writes. The box is reached only through the box interface: `exec` with argv (`rm`), never a
// shell line, and `copyIn` of a folder dipo made.

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError } from "../git/runner";
import { type PushResult, pushBranch } from "../git/task-commit";
import { BOX_WORKDIR, type BoxCodeDeps, filtersOffConfig, unpack } from "./code";
import { cleanDoorText } from "./door";
import {
  type BoxParts,
  type PartPark,
  partPark,
  type PartRun,
  partSubject,
  unsafePath,
} from "./parts";
import { BoxError, type BoxPort } from "./port";

/** How often the live box runs are compared and caught up. */
export const COLLISION_POLL_MS = 60_000;
/** The prefix of the stage folder of one catch-up in dipo's temp root. */
export const CATCH_UP_STAGE_PREFIX = "dipo-box-catch-up-";
/** How long one command in the box may take while the merge is copied in. */
export const CATCH_UP_EXEC_TIMEOUT_MS = 60_000;
/** The message of the part dipo takes from the box before it merges. */
export const CATCH_UP_PART_MESSAGE = "Work in progress before dipo merges the new base";
/** How many paths a notice or message names; the rest are counted. */
export const SHOWN_PATHS_MAX = 20;
/** How many paths one git or box call names. */
const PATHS_PER_CALL = 100;

/** `engine.notice` codes of overlaps and catch-ups. */
export const COLLISION_NOTICES = {
  overlap: "box.storiesOverlap",
  caughtUp: "box.caughtUp",
  conflict: "box.catchUpConflict",
  backlogConflict: "box.catchUpBacklogConflict",
  failed: "box.catchUpFailed",
} as const;

/** The park causes of a catch-up. */
export const CATCH_UP_CAUSES = {
  failed: "catch-up-failed",
  pushRejected: "push-rejected",
} as const;

// ---- the prefix rule -----------------------------------------------------------------------------

/** True when `a` and `b` are the same path or one is a folder above the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The folders above `path`: `a/b/c` gives `a` and `a/b`. */
function foldersAbove(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, at) => parts.slice(0, at + 1).join("/"));
}

/** Pure: the paths of `mine` that overlap a path of `theirs` by the prefix rule, sorted. */
export function overlappingPaths(mine: readonly string[], theirs: readonly string[]): string[] {
  const exact = new Set(theirs);
  const above = new Set(theirs.flatMap(foldersAbove));
  const found = new Set<string>();
  for (const path of mine) {
    if (exact.has(path) || above.has(path) || foldersAbove(path).some((dir) => exact.has(dir))) {
      found.add(path);
    }
  }
  return [...found].toSorted();
}

/** One story's changed files. */
export interface StoryChanges {
  readonly runId: string;
  readonly story: string;
  readonly files: readonly string[];
}

/** Two stories in progress that change overlapping files. */
export interface StoryOverlap {
  readonly a: { readonly runId: string; readonly story: string };
  readonly b: { readonly runId: string; readonly story: string };
  /** The overlapping paths of both, sorted. */
  readonly paths: readonly string[];
}

/** Pure: every pair of `stories` whose changed files overlap, in the order given. */
export function findOverlaps(stories: readonly StoryChanges[]): StoryOverlap[] {
  const overlaps: StoryOverlap[] = [];
  for (let i = 0; i < stories.length; i += 1) {
    for (let j = i + 1; j < stories.length; j += 1) {
      const a = stories[i]!;
      const b = stories[j]!;
      const paths = new Set([
        ...overlappingPaths(a.files, b.files),
        ...overlappingPaths(b.files, a.files),
      ]);
      if (paths.size === 0) continue;
      overlaps.push({
        a: { runId: a.runId, story: a.story },
        b: { runId: b.runId, story: b.story },
        paths: [...paths].toSorted(),
      });
    }
  }
  return overlaps;
}

/** Pure: what makes an overlap new: its two runs, in either order, and its paths. */
export function overlapSignature(overlap: StoryOverlap): string {
  const runs = [overlap.a.runId, overlap.b.runId].toSorted();
  return JSON.stringify([...runs, ...overlap.paths]);
}

// ---- the texts -----------------------------------------------------------------------------------

/** Pure: `paths` cleaned for a notice or message, at most `SHOWN_PATHS_MAX`, the rest counted. */
export function shownPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, SHOWN_PATHS_MAX).map((path) => cleanDoorText(path).slice(0, 300));
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** Pure: the maintainer's notice of an overlap. */
export function overlapNotice(overlap: StoryOverlap): string {
  return `${overlap.a.story} and ${overlap.b.story} are both in progress and change the same ${files(overlap.paths.length)}: ${shownPaths(overlap.paths)}. Both continue; when one merges, dipo merges the new base into the other's branch and box.`;
}

/** Pure: the message to a worker whose story overlaps `other`'s. */
export function overlapMessage(other: string, paths: readonly string[]): string {
  return `dipo: another story in progress, ${other}, changes the same ${files(paths.length)} as you: ${shownPaths(paths)}. Both stories continue. Keep your changes to these files to what your story needs. When ${other} merges first, dipo merges the new base into your branch, copies the result into your box and tells you.`;
}

/** What a catch-up did, for its texts. */
export interface CatchUpFacts {
  readonly story: string;
  readonly base: string;
  /** The base commit merged in. */
  readonly onto: string;
  /** The paths of the story that the base changed too. */
  readonly overlap: readonly string[];
  /** The paths git could not merge cleanly; empty for a clean merge. */
  readonly conflicts: readonly string[];
  /** The paths written into the box and removed from it. */
  readonly written: number;
  readonly removed: number;
}

/** Pure: the maintainer's notice of a catch-up. */
export function catchUpNotice(facts: CatchUpFacts): string {
  const at = `${facts.base} at ${facts.onto.slice(0, 12)}`;
  return facts.conflicts.length === 0
    ? `dipo merged ${at} into ${facts.story}'s branch and box: the base changed ${files(facts.overlap.length)} the story changed too (${shownPaths(facts.overlap)}).`
    : `git could not merge ${at} into ${facts.story}'s branch cleanly: ${files(facts.conflicts.length)} conflict (${shownPaths(facts.conflicts)}). dipo committed the merge with git's conflict markers, copied it into the box, and gave the worker a fix round.`;
}

/** Pure: the message to the worker of a caught-up story. */
export function catchUpMessage(facts: CatchUpFacts): string {
  const copied = `It copied the merge into your box: ${files(facts.written)} written, ${files(facts.removed)} removed.`;
  if (facts.conflicts.length === 0) {
    return `dipo: ${facts.base} changed files your story changes too (${shownPaths(facts.overlap)}), so dipo merged ${facts.base} into your branch. ${copied} Read those files again before you change them further, and keep going.`;
  }
  return `dipo: fix round. ${facts.base} changed files your story changes too, and git could not merge them cleanly: ${shownPaths(facts.conflicts)}. dipo committed the merge with git's conflict markers (<<<<<<<, =======, >>>>>>>) in those files. ${copied} Resolve every conflict so the code keeps both changes where they belong, remove the markers, run the tests, then hand a part with dipo-part.`;
}

/** Pure: the maintainer's notice of a conflict in the backlog, which dipo leaves alone. */
export function backlogConflictNotice(
  story: string,
  base: string,
  paths: readonly string[],
): string {
  return `git could not merge ${base} into ${story}'s branch cleanly, and the conflict is in the backlog (${shownPaths(paths)}), which only dipo and the maintainer write. dipo left the branch and the box as they are; ${story} continues. Resolve the task file on the base by hand.`;
}

/** Pure: the commit message of a catch-up merge. */
export function catchUpCommitMessage(
  facts: Pick<CatchUpFacts, "story" | "base" | "onto" | "conflicts">,
  branch: string,
): { readonly subject: string; readonly body: string } {
  const body = [
    `Catch-up of ${facts.story} with ${facts.base} at ${facts.onto.slice(0, 12)}, merged by dipo.`,
  ];
  if (facts.conflicts.length > 0) {
    body.push(
      `git could not merge ${files(facts.conflicts.length)} cleanly; they hold its conflict markers for the worker's fix round.`,
    );
  }
  return {
    subject: partSubject(`Merge ${facts.base} into ${branch}`, "Merge the base"),
    body: body.join("\n\n"),
  };
}

// ---- reading git ---------------------------------------------------------------------------------

function inBacklog(path: string): boolean {
  return path === "backlog" || path.startsWith("backlog/");
}

function nulList(output: string): string[] {
  return output.split("\0").filter((item) => item !== "");
}

/** Pure: the tree and the conflicted paths of `git merge-tree --write-tree --name-only -z --no-messages`. */
export function parseMergeTree(output: string): {
  readonly tree: string;
  readonly conflicts: string[];
} {
  const [tree = "", ...paths] = output.split("\0");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
    throw new GitError("git.failed", "git merge-tree printed no tree.");
  }
  return { tree, conflicts: [...new Set(paths.filter((path) => path !== ""))].toSorted() };
}

/** What a merge changes in the box: the paths to write and to remove, outside `backlog/`. */
export interface BoxChanges {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Pure: the box changes of `git diff-tree -r -z --no-renames <tip> <merge>` output. A submodule is
 * never written; a path that became one is removed.
 */
export function parseBoxChanges(output: string): BoxChanges {
  const items = output.split("\0");
  const written: string[] = [];
  const removed: string[] = [];
  for (let at = 0; at + 1 < items.length; at += 2) {
    const head = items[at]!;
    const path = items[at + 1]!;
    if (!head.startsWith(":") || inBacklog(path)) continue;
    const [, newMode = ""] = head.slice(1).split(" ");
    const status = head.split(" ").at(-1) ?? "";
    if (status.startsWith("D") || newMode === "160000") removed.push(path);
    else written.push(path);
  }
  return { written: written.toSorted(), removed: removed.toSorted() };
}

/** True when `path` is a plain repo-relative path: no empty, `.` or `..` part, nothing hidden. */
function plainPath(path: string): boolean {
  return (
    !unsafePath(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function revParse(session: GitSession, rev: string): Promise<string | null> {
  const found = await session.step(session.repository, ["rev-parse", "--verify", "--quiet", rev]);
  return found.code === 0 ? found.stdout.trim() : null;
}

async function isAncestor(session: GitSession, older: string, newer: string): Promise<boolean> {
  const checked = await session.step(session.repository, [
    "merge-base",
    "--is-ancestor",
    older,
    newer,
  ]);
  return checked.code === 0;
}

async function namesBetween(session: GitSession, from: string, to: string): Promise<string[]> {
  return nulList(
    await session.ok(session.repository, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      from,
      to,
      "--",
    ]),
  ).filter((path) => !inBacklog(path));
}

/**
 * The base branch's ref for a catch-up: `refs/remotes/<remote>/<base>` when the office has a
 * remote, else `refs/heads/<base>`; null when the office has no base branch.
 */
export async function baseRefOf(
  git: OfficeGit,
  session: GitSession,
): Promise<{ readonly base: string; readonly ref: string } | null> {
  const base = await git.resolveBaseIn(session).catch(() => null);
  if (base === null) return null;
  const { remote } = git.settings;
  const url = await session.step(session.repository, ["config", "--get", `remote.${remote}.url`]);
  const remoteRef = `refs/remotes/${remote}/${base}`;
  return {
    base,
    ref: url.code === 0 && url.stdout.trim() !== "" ? remoteRef : `refs/heads/${base}`,
  };
}

/** Where a story's changes start: its start commit, or the merge base after a catch-up. */
async function startPoint(
  session: GitSession,
  tip: string,
  startSha: string,
  baseRef: string | null,
): Promise<{ readonly from: string; readonly mergeBase: string | null }> {
  if (baseRef === null || (await revParse(session, `${baseRef}^{commit}`)) === null) {
    return { from: startSha, mergeBase: null };
  }
  const found = await session.step(session.repository, ["merge-base", tip, baseRef]);
  const mergeBase = found.code === 0 ? found.stdout.trim() : null;
  if (mergeBase === null || mergeBase === startSha) return { from: startSha, mergeBase };
  return {
    from: (await isAncestor(session, startSha, mergeBase)) ? mergeBase : startSha,
    mergeBase,
  };
}

/**
 * A story's changed files (criterion 1): the paths the branch tip changed against the start
 * commit, or against the merge base with `baseRef` once a catch-up brought the base in, without
 * `backlog/`. Read from git, never from the worker. Null when the branch is gone.
 */
export async function storyChangedFiles(
  session: GitSession,
  input: { readonly branch: string; readonly startSha: string; readonly baseRef: string | null },
): Promise<{ readonly tip: string; readonly from: string; readonly files: string[] } | null> {
  const tip = await revParse(session, `refs/heads/${input.branch}^{commit}`);
  if (tip === null) return null;
  const { from } = await startPoint(session, tip, input.startSha, input.baseRef);
  return { tip, from, files: await namesBetween(session, from, tip) };
}

/** What a catch-up check found. */
export type CatchUpPlan =
  /** The branch holds the base already, or there is no base to merge. */
  | { readonly kind: "current" }
  /** The base changed nothing the story changed: no catch-up. */
  | { readonly kind: "apart"; readonly onto: string }
  /** The merge conflicts inside `backlog/`: the maintainer's. */
  | { readonly kind: "backlog"; readonly onto: string; readonly conflicts: readonly string[] }
  | {
      readonly kind: "merge";
      readonly tip: string;
      readonly onto: string;
      readonly tree: string;
      /** The merge commit, made only when asked to write. */
      readonly commit: string | null;
      readonly overlap: readonly string[];
      readonly conflicts: readonly string[];
    };

/**
 * The catch-up check of one story (criterion 4): does the base hold changes, since the merge base,
 * to files the story changed, and does git merge them cleanly (`git merge-tree --write-tree` from
 * objects alone)? With `write` the merge commit is made too (`commit-tree`, the tip and the base
 * as parents), but no ref moves.
 */
export async function planCatchUp(
  session: GitSession,
  input: {
    readonly branch: string;
    readonly startSha: string;
    readonly story: string;
    readonly base: string;
    readonly baseRef: string;
    readonly write: boolean;
  },
): Promise<CatchUpPlan> {
  const repo = session.repository;
  const tip = await revParse(session, `refs/heads/${input.branch}^{commit}`);
  const onto = await revParse(session, `${input.baseRef}^{commit}`);
  if (tip === null || onto === null || (await isAncestor(session, onto, tip))) {
    return { kind: "current" };
  }
  const { from, mergeBase } = await startPoint(session, tip, input.startSha, input.baseRef);
  if (mergeBase === null) return { kind: "apart", onto };
  const overlap = overlappingPaths(
    await namesBetween(session, from, tip),
    await namesBetween(session, mergeBase, onto),
  );
  if (overlap.length === 0) return { kind: "apart", onto };
  const filtersOff = { config: await filtersOffConfig(session), env: BASE_CHECKOUT_ENV };
  const merged = await session.step(
    repo,
    ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", tip, onto],
    filtersOff,
  );
  if (merged.code !== 0 && merged.code !== 1) {
    throw new GitError(
      "git.failed",
      `git merge-tree failed (${merged.stderr.trim() || `exit ${merged.code}`}).`,
    );
  }
  const { tree, conflicts } = parseMergeTree(merged.stdout);
  if (merged.code === 1 && conflicts.length === 0) {
    throw new GitError("git.failed", "git merge-tree reported a conflict but named no file.");
  }
  const inTheBacklog = conflicts.filter(inBacklog);
  if (inTheBacklog.length > 0) return { kind: "backlog", onto, conflicts: inTheBacklog };
  let commit: string | null = null;
  if (input.write) {
    const message = catchUpCommitMessage({ ...input, onto, conflicts }, input.branch);
    commit = (
      await session.ok(
        repo,
        ["commit-tree", tree, "-p", tip, "-p", onto, "-m", message.subject, "-m", message.body],
        { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
      )
    ).trim();
  }
  return { kind: "merge", tip, onto, tree, commit, overlap, conflicts };
}

/** The box changes of the merge `commit` against the tip it was made on. */
export async function boxChangesOf(
  session: GitSession,
  tip: string,
  commit: string,
): Promise<BoxChanges> {
  const changes = parseBoxChanges(
    await session.ok(session.repository, ["diff-tree", "-r", "-z", "--no-renames", tip, commit]),
  );
  if (![...changes.written, ...changes.removed].every(plainPath)) {
    throw new GitError("git.failed", "the merge holds a path dipo does not copy into a box.");
  }
  return changes;
}

/** Moves `branch` from `tip` to `commit`; false when it moved meanwhile. */
export async function moveBranch(
  session: GitSession,
  branch: string,
  commit: string,
  tip: string,
  subject: string,
): Promise<boolean> {
  const moved = await session.step(session.repository, [
    "update-ref",
    "-m",
    subject,
    `refs/heads/${branch}`,
    commit,
    tip,
  ]);
  return moved.code === 0;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += PATHS_PER_CALL) {
    out.push(items.slice(at, at + PATHS_PER_CALL));
  }
  return out;
}

// ---- the service ---------------------------------------------------------------------------------

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/** A notice for the maintainer. */
export interface CollisionNotice {
  readonly level: "info" | "warn";
  readonly code: string;
  readonly text: string;
}

export interface BoxCollisionsDeps {
  readonly boxes: Pick<BoxPort, "copyIn" | "exec">;
  /** The `tar` that unpacks a merge for the box, and the clock of the poll. */
  readonly code: BoxCodeDeps;
  /** dipo's temp root; each catch-up's stage folder is made in it. */
  readonly tmpRoot: string;
  /** The box runs in progress, every office. */
  readonly runs: () => readonly PartRun[];
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** True while the run goes on: tracked and nothing decided for it yet. */
  readonly live: (runId: string) => boolean;
  /** The delivery of parts: the box's work goes first, and the catch-up takes the run's turn. */
  readonly parts: Pick<BoxParts, "deliverLast" | "inTurn">;
  /** Parks the run, stopping its worker; false when another decision came first. */
  readonly park: (runId: string, park: PartPark) => boolean;
  /** Sends `text` to the run's worker as its next message. */
  readonly tell: (runId: string, text: string) => Promise<unknown>;
  /** Tells the maintainer (an `engine.notice` of the run). */
  readonly notice: (office: OfficeId, runId: string, notice: CollisionNotice) => void;
  readonly pollMs?: number;
  readonly warn?: Log;
  readonly info?: Log;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compares the changed files of the box runs in progress and lets the second catch up. */
export class BoxCollisions {
  readonly #deps: BoxCollisionsDeps;
  /** The overlaps told already, by `overlapSignature`. */
  readonly #told = new Set<string>();
  /** The base commit a backlog conflict was told for, per run. */
  readonly #backlogTold = new Map<string, string>();
  #pass: Promise<void> | null = null;
  #again = false;
  #timer: TimerHandle | null = null;
  #stopped = false;

  constructor(deps: BoxCollisionsDeps) {
    this.#deps = deps;
  }

  /** Arms the poll: a pass every `COLLISION_POLL_MS`. */
  start(): void {
    this.#stopped = false;
    this.#arm();
  }

  /** Stops the poll; a pass in progress finishes. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#deps.code.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = this.#deps.code.clock.setTimeout(() => {
      this.#timer = null;
      void this.check().finally(() => this.#arm());
    }, this.#deps.pollMs ?? COLLISION_POLL_MS);
  }

  /**
   * One pass over every office: overlaps told, then each story whose base changed its files caught
   * up. One pass at a time; a call during a pass runs one more after it. Never rejects.
   */
  check(): Promise<void> {
    if (this.#pass !== null) {
      this.#again = true;
      return this.#pass;
    }
    const pass = (async () => {
      do {
        this.#again = false;
        await this.#once().catch((error: unknown) => {
          this.#deps.warn?.("comparing the box runs' changed files failed", {
            reason: messageOf(error),
          });
        });
      } while (this.#again && !this.#stopped);
    })();
    this.#pass = pass.finally(() => {
      this.#pass = null;
    });
    return this.#pass;
  }

  async #once(): Promise<void> {
    const runs = this.#deps.runs().filter((run) => this.#deps.live(run.runId));
    const byOffice = new Map<OfficeId, PartRun[]>();
    for (const run of runs) byOffice.set(run.office, [...(byOffice.get(run.office) ?? []), run]);
    const ids = new Set(runs.map((run) => run.runId));
    for (const signature of this.#told) {
      const [a, b] = JSON.parse(signature) as string[];
      if (!ids.has(a ?? "") || !ids.has(b ?? "")) this.#told.delete(signature);
    }
    for (const runId of this.#backlogTold.keys()) {
      if (!ids.has(runId)) this.#backlogTold.delete(runId);
    }
    for (const [office, inOffice] of byOffice) {
      const git = this.#deps.git(office);
      if (git === undefined) continue;
      await this.#overlaps(office, git, inOffice);
      for (const run of inOffice) {
        await this.#maybeCatchUp(git, run).catch((error: unknown) => {
          this.#deps.warn?.("a box run could not catch up with its base", {
            run: run.runId,
            reason: messageOf(error),
          });
        });
      }
    }
  }

  async #overlaps(office: OfficeId, git: OfficeGit, runs: readonly PartRun[]): Promise<void> {
    if (runs.length < 2) return;
    const changes = await git.run(async (session) => {
      const base = await baseRefOf(git, session);
      const out: StoryChanges[] = [];
      for (const run of runs) {
        const changed = await storyChangedFiles(session, {
          branch: run.branch,
          startSha: run.startSha,
          baseRef: base?.ref ?? null,
        });
        if (changed !== null)
          out.push({ runId: run.runId, story: run.story, files: changed.files });
      }
      return out;
    });
    for (const overlap of findOverlaps(changes)) {
      const signature = overlapSignature(overlap);
      if (this.#told.has(signature)) continue;
      this.#told.add(signature);
      this.#deps.notice(office, overlap.a.runId, {
        level: "warn",
        code: COLLISION_NOTICES.overlap,
        text: overlapNotice(overlap),
      });
      for (const [me, other] of [
        [overlap.a, overlap.b],
        [overlap.b, overlap.a],
      ] as const) {
        await this.#tell(me.runId, overlapMessage(other.story, overlap.paths));
      }
    }
  }

  async #tell(runId: string, text: string): Promise<void> {
    await Promise.resolve(this.#deps.tell(runId, text)).catch((error: unknown) => {
      this.#deps.warn?.("a collision message did not reach the worker", {
        run: runId,
        reason: messageOf(error),
      });
    });
  }

  /** Plans without writing first, so a story whose base did not touch its files is left alone. */
  async #maybeCatchUp(git: OfficeGit, run: PartRun): Promise<void> {
    const plan = await this.#plan(git, run, false);
    if (plan === null || plan.kind === "current" || plan.kind === "apart") return;
    if (plan.kind === "backlog") {
      this.#tellBacklog(run, plan.base, plan.onto, plan.conflicts);
      return;
    }
    // Whatever the box holds goes first, so the branch tip is the box's code when git merges.
    const before = await this.#deps.parts.deliverLast(run.runId, CATCH_UP_PART_MESSAGE);
    const park = partPark(before);
    if (park !== null) {
      this.#deps.park(run.runId, park);
      return;
    }
    if (before.kind === "stopped") return;
    await this.#deps.parts.inTurn(run.runId, () => this.#catchUp(git, run));
  }

  #tellBacklog(run: PartRun, base: string, onto: string, conflicts: readonly string[]): void {
    if (this.#backlogTold.get(run.runId) === onto) return;
    this.#backlogTold.set(run.runId, onto);
    this.#deps.notice(run.office, run.runId, {
      level: "warn",
      code: COLLISION_NOTICES.backlogConflict,
      text: backlogConflictNotice(run.story, base, conflicts),
    });
  }

  async #plan(
    git: OfficeGit,
    run: PartRun,
    write: boolean,
  ): Promise<(CatchUpPlan & { readonly base: string }) | null> {
    return git.run(async (session) => {
      const base = await baseRefOf(git, session);
      if (base === null) return null;
      const plan = await planCatchUp(session, {
        branch: run.branch,
        startSha: run.startSha,
        story: run.story,
        base: base.base,
        baseRef: base.ref,
        write,
      });
      return { ...plan, base: base.base };
    });
  }

  /** The catch-up itself, in the run's turn (see the file comment). */
  async #catchUp(git: OfficeGit, run: PartRun): Promise<void> {
    if (!this.#deps.live(run.runId)) return;
    const plan = await this.#plan(git, run, true);
    if (plan === null || plan.kind === "current" || plan.kind === "apart") return;
    if (plan.kind === "backlog") {
      this.#tellBacklog(run, plan.base, plan.onto, plan.conflicts);
      return;
    }
    const commit = plan.commit;
    if (commit === null) return;
    const changes = await git.run((session) => boxChangesOf(session, plan.tip, commit));
    const fail = (detail: string): void => {
      this.#deps.notice(run.office, run.runId, {
        level: "warn",
        code: COLLISION_NOTICES.failed,
        text: `${run.story}: ${detail}`,
      });
      this.#deps.park(run.runId, { reason: "conflict", cause: CATCH_UP_CAUSES.failed, detail });
    };
    try {
      await this.#intoBox(git, run, commit, changes);
    } catch (error) {
      this.#deps.warn?.("a catch-up could not be copied into the box", {
        run: run.runId,
        reason: messageOf(error),
      });
      fail(
        `dipo could not copy the merge of ${plan.base} into the box, so the box may hold part of it; the branch was not moved. Resume the story to try again.`,
      );
      return;
    }
    const subject = `Merge ${plan.base} into ${run.branch}`;
    const moved = await git.run((session) =>
      moveBranch(session, run.branch, commit, plan.tip, subject),
    );
    if (!moved) {
      fail(
        `the branch ${run.branch} moved while dipo merged ${plan.base} into it, after the merge was copied into the box. Check the branch and the box, then resume the story.`,
      );
      return;
    }
    const push: PushResult = await git
      .run((session) => pushBranch(session, git.settings.remote, run.branch))
      .catch((error: unknown) => ({ pushed: false, rejected: false, error: messageOf(error) }));
    const facts: CatchUpFacts = {
      story: run.story,
      base: plan.base,
      onto: plan.onto,
      overlap: plan.overlap,
      conflicts: plan.conflicts,
      written: changes.written.length,
      removed: changes.removed.length,
    };
    this.#deps.info?.("a box run caught up with its base", {
      run: run.runId,
      commit,
      conflicts: plan.conflicts.length,
    });
    this.#deps.notice(run.office, run.runId, {
      level: plan.conflicts.length === 0 ? "info" : "warn",
      code: plan.conflicts.length === 0 ? COLLISION_NOTICES.caughtUp : COLLISION_NOTICES.conflict,
      text: catchUpNotice(facts),
    });
    if (push.rejected) {
      this.#deps.park(run.runId, {
        reason: "conflict",
        cause: CATCH_UP_CAUSES.pushRejected,
        detail: `${push.error ?? "the push was rejected"}; the remote branch has commits the story branch lacks`,
      });
      return;
    }
    if (push.error !== null) {
      this.#deps.warn?.("a catch-up was committed but not pushed", {
        run: run.runId,
        reason: push.error,
      });
    }
    await this.#tell(run.runId, catchUpMessage(facts));
  }

  /** Removes and writes the merge's paths in the box (see the file comment). */
  async #intoBox(git: OfficeGit, run: PartRun, commit: string, changes: BoxChanges): Promise<void> {
    const stage = await realpath(await mkdtemp(join(this.#deps.tmpRoot, CATCH_UP_STAGE_PREFIX)));
    try {
      const dir = join(stage, "files");
      await mkdir(dir, { mode: 0o755 });
      // Unpacked on the Mac first, so a failed archive changes nothing in the box.
      let n = 0;
      for (const group of chunks(changes.written)) {
        n += 1;
        const archive = join(stage, `merge-${n}.tar`);
        await git.run(async (session) =>
          session.ok(
            session.repository,
            [
              "--literal-pathspecs",
              "archive",
              "--format=tar",
              `--output=${archive}`,
              commit,
              "--",
              ...group,
            ],
            { config: await filtersOffConfig(session), env: BASE_CHECKOUT_ENV },
          ),
        );
        await unpack(this.#deps.code, archive, dir);
        await rm(archive, { force: true });
      }
      for (const group of chunks(changes.removed)) {
        const removed = await this.#deps.boxes.exec(
          run.box,
          ["rm", "-f", "--", ...group.map((path) => `${BOX_WORKDIR}/${path}`)],
          { timeoutMs: CATCH_UP_EXEC_TIMEOUT_MS },
        );
        if (removed.code !== 0) {
          throw new BoxError(
            "box.failed",
            `removing files in the box failed (exit ${removed.code}).`,
          );
        }
      }
      if (changes.written.length > 0) {
        await this.#deps.boxes.copyIn(run.box, `${dir}/.`, BOX_WORKDIR);
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
