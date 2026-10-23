// Conflicts with the base before In Review and the conflict hand-off of a box run (0019 sections 6,
// 8 and 10; 0021 section 12 and its amendment of 2026-10-22; DIPO-149 with DIPO-291's marker
// check). For a box run every merge happens in dipo's own git, never in the box (0021 sections 8
// and 14), so 0019's "leave the merge in progress" becomes DIPO-277's committed catch-up: git's
// result, markers and all, is committed on the story branch from git objects and copied into the
// box, and the worker's resolution comes back as an ordinary part.
//
// - Records (`catch_ups`, migration 45). Every merge dipo made into a story branch is recorded
//   with the base commit, the tip it was made on, the merge commit and the conflicted paths (a
//   catch-up of the poll or the sync before In Review). This is dipo's ref journal for carried
//   approvals and the list of paths the check at done reads. A conflict the poll finds while the
//   story is In Review is recorded as `found`, told once per base commit and shown on the story
//   detail (`baseConflictOf`); nothing is merged, and the story's next In Review or merge-slot
//   sync handles it (0019 section 10); a later check that finds none clears it (`cleared`).
// - One story, one branch. Records and hand-offs are read by the story and its branch across runs
//   (`storyMerges`, `handOffState`): a re-claim of a kept branch is a new run, and its branch
//   still holds what the earlier runs' merges left. The claim of a box run's reused branch merges
//   nothing itself (`baseSync: "catch-up"`); the catch-up does, so its conflicts are hand-offs too.
// - At done (`StoryConflicts.atDone`, in the run's held turn of parts after the last part, before
//   its end is claimed). First the check of what is left unresolved (`unresolvedAt`): a recorded
//   content-conflicted path, or any path added or renamed since a conflicted merge, whose blob on
//   the tip holds a conflict marker line (git's own markers, read with `git grep -a` from git
//   objects, a NUL byte included; a lone `=======` only beside a `<<<<<<< ` or `>>>>>>> ` line),
//   and a binary, modify/delete or file vs folder conflict whose path is unchanged since the
//   merge, keeps the story from In Review, so from the PR too: it goes back to the worker as a
//   feedback turn naming the files and lines. Then the
//   fetch and the sync (`BoxCollisions.syncInTurn`): `git merge-tree --write-tree` of the tip and
//   the base; a story of tier L or flagged test-before-merge merges the base whenever it moved,
//   any other only on a conflict. A conflict is committed as git left it, copied into the box,
//   recorded, and sent to the worker as one conflict item (its paths and hunks within the item
//   budget, signed over the base commit and the sorted paths). A conflict in a path the worker
//   cannot write parks `conflict` with cause `unwritable-path` and merges nothing. A clean sync
//   moves the story to review at the merged head; CI on that head is its verify (0021 amendment
//   of 2026-10-22), so dipo runs none.
// - Hand-offs (`run_steps` kind `conflict`, values `start <n> <commit>`, `feedback <n>`,
//   `failed <n> <why>` and `resolved <n>`). A recorded conflicted merge starts hand-off n. At a
//   done with markers left, the hand-off gets its one feedback turn; at the next done with
//   markers, or at a blocked report while it is open, it fails. The failed hand-off that reaches
//   the run's conflict cap (`mergeSlot.conflictAttempts`, snapshot as `runs.conflict_cap`) parks
//   `conflict` with cause `merge-in-progress` and the paths, the merge kept on the branch and in
//   the box; below the cap a new hand-off starts with the same feedback. A done without markers
//   resolves the open hand-off. `run_outcomes.conflict_handoffs` counts the hand-offs started.
// - Carried approvals (0019 section 6). After a clean merge dipo made, the run's newest verdict, if
//   approved, carries to the new head when every commit between the approved head and the head
//   (first parents) is a clean merge in the journal or a commit that changes only the story's task
//   file: a carried `review_verdicts` row on the head's code tree key, so the review starter takes
//   it without a round. A merge the journal does not hold never carries one.

import type { IdSource, OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { TEST_BEFORE_MERGE } from "../backlog/fields/labels";
import { isTaskFileOf, TASKS_DIR } from "../backlog/runner";
import {
  type CatchUpFound,
  type CatchUpMerged,
  type ConflictFile,
  markersAt,
  markersLeftText,
  shownPaths,
  type SyncMode,
  type SyncOutcome,
} from "../box/collisions";
import type { PartRun } from "../box/parts";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { recordReviewVerdict, reviewDecidedEntry, reviewVerdictForTree } from "../review/store";
import { withWorkViews } from "../views/work";

import { runCaps } from "./caps";
import { lastReviewVerdict } from "./fix-rounds";
import { PARK_CAUSES } from "./park";
import { appendRunStep, findRun, IN_REVIEW_END, type StoredRun } from "./records";
import { REVIEWED_END } from "./rounds";
import { codeTreeKeyOf } from "./story-git";

/** `engine.notice` codes of conflicts. */
export const CONFLICT_NOTICES = {
  /** A conflict with the base found while the story is In Review (0019 section 10). */
  inReview: "conflict.inReview",
  /** An approval carried to a head after a clean merge dipo made (0019 section 6). */
  carried: "review.carried",
} as const;

/** The conflict cap of a run that has no snapshot: `mergeSlot.conflictAttempts`' default. */
export const CONFLICT_CAP_DEFAULT = 2;

// ---- records -------------------------------------------------------------------------------------

/** A stored row of `catch_ups`. */
export interface StoredCatchUp {
  readonly catchUpId: number;
  readonly kind: "merged" | "found";
  readonly base: string;
  readonly onto: string;
  readonly tip: string;
  readonly commit: string | null;
  readonly conflicts: readonly ConflictFile[];
  readonly at: number;
}

interface CatchUpRow {
  catch_up_id: number;
  kind: "merged" | "found";
  base: string;
  onto_sha: string;
  tip_sha: string;
  commit_sha: string | null;
  conflicts: string;
  at: number;
}

function toCatchUp(row: CatchUpRow): StoredCatchUp {
  return {
    catchUpId: row.catch_up_id,
    kind: row.kind,
    base: row.base,
    onto: row.onto_sha,
    tip: row.tip_sha,
    commit: row.commit_sha,
    conflicts: JSON.parse(row.conflicts) as ConflictFile[],
    at: row.at,
  };
}

/** Inside the caller's transaction: one row of `catch_ups`; returns it. */
export function recordCatchUp(
  office: OfficeHandle,
  runId: RunId | string,
  input: {
    readonly kind: "merged" | "found";
    readonly base: string;
    readonly onto: string;
    readonly tip: string;
    readonly commit: string | null;
    readonly conflicts: readonly ConflictFile[];
  },
  at: number,
): StoredCatchUp {
  const id =
    office.get<{ id: number }>(
      `select coalesce(max(catch_up_id), 0) + 1 as id from catch_ups
        where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.id ?? 1;
  office.run(
    `insert into catch_ups (office_id, run_id, catch_up_id, kind, base, onto_sha, tip_sha,
       commit_sha, conflicts, at)
     values ($office_id, $run, $id, $kind, $base, $onto, $tip, $commit, $conflicts, $at)`,
    {
      run: runId,
      id,
      kind: input.kind,
      base: input.base,
      onto: input.onto,
      tip: input.tip,
      commit: input.commit,
      conflicts: JSON.stringify(
        [...input.conflicts].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
      at,
    },
  );
  return catchUpsOf(office, runId).at(-1) as StoredCatchUp;
}

/** The run's `catch_ups` rows, oldest first. */
export function catchUpsOf(office: OfficeHandle, runId: RunId | string): StoredCatchUp[] {
  return office
    .all<CatchUpRow>(
      `select catch_up_id, kind, base, onto_sha, tip_sha, commit_sha, conflicts, at from catch_ups
        where office_id = $office_id and run_id = $run order by catch_up_id`,
      { run: runId },
    )
    .map(toCatchUp);
}

/**
 * The merges dipo made into the run's branch, oldest first, by every run of the same story on the
 * same branch: a re-claim of a kept branch is a new run, and the conflicts its branch still holds
 * come from the merges of the runs before it (DIPO-149).
 */
export function storyMerges(office: OfficeHandle, runId: RunId | string): StoredCatchUp[] {
  return office
    .all<CatchUpRow>(
      `select c.catch_up_id, c.kind, c.base, c.onto_sha, c.tip_sha, c.commit_sha, c.conflicts, c.at
        from catch_ups c
        join runs r on r.office_id = c.office_id and r.run_id = c.run_id
        join runs me on me.office_id = c.office_id and me.run_id = $run
        where c.office_id = $office_id and c.kind = 'merged'
          and (c.run_id = $run or (r.key is me.key and r.branch is me.branch))
        order by r.started_at, r.rowid, c.catch_up_id`,
      { run: runId },
    )
    .map(toCatchUp);
}

/** The conflicted paths of every merge dipo made into the run's branch (`storyMerges`), sorted. */
export function recordedConflictPaths(office: OfficeHandle, runId: RunId | string): string[] {
  const paths = new Set<string>();
  for (const row of storyMerges(office, runId)) {
    for (const file of row.conflicts) paths.add(file.path);
  }
  return [...paths].toSorted();
}

/** What of dipo's conflicted merges the branch tip has not resolved (`unresolvedAt`). */
export interface Unresolved {
  /** Files holding conflict marker lines, with their line numbers. */
  readonly markers: ReadonlyMap<string, readonly number[]>;
  /** Binary, modify/delete and file vs folder conflicts whose path is unchanged since the merge. */
  readonly unchanged: readonly ConflictFile[];
}

/**
 * What the tip `tip` has not resolved of `merges`' conflicts, read from git objects (DIPO-149):
 * conflict markers in the recorded paths and in every path added or renamed since a conflicted
 * merge (a conflicted file moved elsewhere keeps its markers); and each conflict of another kind
 * whose path at the tip is what the merge commit held (git's own result, untouched).
 */
export async function unresolvedAt(
  session: GitSession,
  tip: string,
  merges: readonly StoredCatchUp[],
): Promise<Unresolved> {
  const repo = session.repository;
  const scan = new Set<string>();
  const unchanged: ConflictFile[] = [];
  const blob = async (commit: string, path: string): Promise<string | null> => {
    const found = await session.step(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}:${path}`,
    ]);
    return found.code === 0 ? found.stdout.trim() : null;
  };
  for (const row of merges) {
    if (row.commit === null || row.conflicts.length === 0) continue;
    const commit = row.commit;
    const known = (await session.step(repo, ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
    for (const file of row.conflicts) {
      if (file.kind === "content") scan.add(file.path);
      else if (known && (await blob(commit, file.path)) === (await blob(tip, file.path))) {
        unchanged.push(file);
      }
    }
    if (!known) continue;
    const moved = await session.ok(repo, [
      "diff",
      "--name-only",
      "-z",
      "-M",
      "--diff-filter=AR",
      commit,
      tip,
      "--",
    ]);
    for (const path of moved.split("\0")) if (path !== "") scan.add(path);
  }
  const markers: ReadonlyMap<string, readonly number[]> =
    scan.size === 0 ? new Map() : await markersAt(session, tip, [...scan].toSorted());
  const seen = new Set<string>();
  return {
    markers,
    unchanged: unchanged.filter((file) => {
      if (seen.has(file.path) || markers.has(file.path)) return false;
      seen.add(file.path);
      return true;
    }),
  };
}

/**
 * The conflict with the base the story's newest run was found to have while In Review, unless a
 * merge dipo made since handled it: for `story.detail` (0019 section 10).
 */
export function baseConflictOf(
  office: OfficeHandle,
  key: StoryKey,
): {
  readonly base: string;
  readonly onto: string;
  readonly paths: string[];
  readonly at: number;
} | null {
  const run = office.get<{ run_id: string }>(
    `select run_id from runs where office_id = $office_id and key = $key and kind = 'story'
      order by started_at desc, rowid desc limit 1`,
    { key },
  );
  if (run === null) return null;
  const last = catchUpsOf(office, run.run_id).at(-1);
  if (last === undefined || last.kind !== "found") return null;
  return {
    base: last.base,
    onto: last.onto,
    paths: last.conflicts.map((file) => file.path),
    at: last.at,
  };
}

/**
 * The story runs of the office waiting In Review: ended at In Review or after their review, with a
 * live claim and no open park. The poll checks their tips against the base (0019 section 10).
 */
export function inReviewRunIds(office: OfficeHandle): RunId[] {
  return office
    .all<{ run_id: string }>(
      `select r.run_id from runs r
        where r.office_id = $office_id and r.kind = 'story' and r.ended_at is not null
          and r.end_kind in ($in_review, $reviewed)
          and exists (select 1 from claims c where c.office_id = r.office_id
            and c.run_id = r.run_id and c.released_at is null)
          and not exists (select 1 from parks p where p.office_id = r.office_id
            and p.run_id = r.run_id and p.resolved_at is null)
        order by r.ended_at, r.run_id`,
      { in_review: IN_REVIEW_END, reviewed: REVIEWED_END },
    )
    .map((row) => row.run_id as RunId);
}

// ---- hand-offs -----------------------------------------------------------------------------------

/** Where the run's conflict hand-offs stand, from its `conflict` steps. */
export interface HandOffState {
  /** The newest hand-off's number; 0 before the first. */
  readonly current: number;
  /** True while the newest hand-off has neither failed nor been resolved. */
  readonly open: boolean;
  /** True when the open hand-off had its one feedback turn. */
  readonly feedback: boolean;
  /** The failed hand-offs of the run: what the conflict cap counts. */
  readonly failed: number;
}

/**
 * Pure: the hand-off state of `conflict` step values, oldest first. With `mine`, a failure counts
 * only where `mine` is not false: an earlier run's failures do not use a new run's cap.
 */
export function handOffStateOf(
  values: readonly string[],
  mine: readonly boolean[] = [],
): HandOffState {
  let current = 0;
  let open = false;
  let feedback = false;
  let failed = 0;
  for (const [at, value] of values.entries()) {
    const [event = "", n = ""] = value.split(" ");
    const number = Number(n);
    if (!Number.isInteger(number)) continue;
    if (event === "start") {
      current = Math.max(current, number);
      open = true;
      feedback = false;
    } else if (number === current && open) {
      if (event === "feedback") feedback = true;
      if (event === "failed") {
        if (mine[at] !== false) failed += 1;
        open = false;
      }
      if (event === "resolved") open = false;
    }
  }
  return { current, open, feedback, failed };
}

/**
 * The run's hand-off state, from the `conflict` steps of every run of the same story on the same
 * branch: a re-claim of a kept branch continues an open hand-off (DIPO-149), and only its own
 * failures count toward its cap.
 */
export function handOffState(office: OfficeHandle, runId: RunId | string): HandOffState {
  const rows = office.all<{ value: string; run_id: string }>(
    `select s.value, s.run_id from run_steps s
      join runs r on r.office_id = s.office_id and r.run_id = s.run_id
      join runs me on me.office_id = s.office_id and me.run_id = $run
      where s.office_id = $office_id and s.kind = 'conflict'
        and (s.run_id = $run or (r.key is me.key and r.branch is me.branch))
      order by r.started_at, r.rowid, s.step`,
    { run: runId },
  );
  return handOffStateOf(
    rows.map((row) => row.value),
    rows.map((row) => row.run_id === runId),
  );
}

/** Inside the caller's transaction: a hand-off event of the run (see the file comment). */
export function appendHandOff(
  office: OfficeHandle,
  runId: RunId | string,
  event:
    | { readonly kind: "start"; readonly n: number; readonly commit: string }
    | { readonly kind: "feedback" | "resolved"; readonly n: number }
    | { readonly kind: "failed"; readonly n: number; readonly why: "markers" | "blocked" },
  at: number,
): void {
  const value =
    event.kind === "start"
      ? `start ${event.n} ${event.commit}`
      : event.kind === "failed"
        ? `failed ${event.n} ${event.why}`
        : `${event.kind} ${event.n}`;
  appendRunStep(office, runId as RunId, "conflict", value, at);
}

/** The run's conflict cap: its snapshot plus grants, else `fallback`. */
export function conflictCapOf(office: OfficeHandle, run: StoredRun, fallback: number): number {
  return runCaps(office, run).conflictCap ?? fallback;
}

/**
 * The park of the failed hand-off that reached the cap (0019 section 10), or, with `capped`, of a
 * done turn that crossed a run cap before the conflict could be handed over.
 */
function capPark(paths: readonly string[], failed: number, cap: number, capped = false) {
  const kept =
    "dipo's merge of the base stays on the branch and in the box for the worker to finish.";
  return {
    reason: "conflict" as const,
    cause: PARK_CAUSES.mergeInProgress,
    detail: capped
      ? `the done turn crossed a run cap before the conflict could be handed over to the worker; conflict markers or unresolved paths remain in ${shownPaths(paths)}. ${kept}`
      : `${failed} conflict hand-off${failed === 1 ? "" : "s"} failed (the conflict cap is ${cap}); conflict markers or unresolved paths remain in ${shownPaths(paths)}. ${kept}`,
  };
}

/**
 * A blocked report of the run's worker (0019 section 10): inside the caller's transaction, an open
 * hand-off fails; the park that replaces the blocked one when that failure reaches the cap, else
 * null (the blocked park goes ahead).
 */
export function blockedHandOff(
  office: OfficeHandle,
  runId: RunId | string,
  at: number,
  fallbackCap = CONFLICT_CAP_DEFAULT,
): ReturnType<typeof capPark> | null {
  const run = findRun(office, runId as RunId);
  if (run === null) return null;
  const state = handOffState(office, runId);
  if (!state.open) return null;
  appendHandOff(office, runId, { kind: "failed", n: state.current, why: "blocked" }, at);
  const cap = conflictCapOf(office, run, fallbackCap);
  return state.failed + 1 >= cap
    ? capPark(recordedConflictPaths(office, runId), state.failed + 1, cap)
    : null;
}

// ---- carried approvals ---------------------------------------------------------------------------

/** The story's task file at `commit`, directly in `backlog/tasks`, or null. */
async function taskFileAt(
  session: GitSession,
  commit: string,
  story: string,
): Promise<string | null> {
  const listed = (
    await session.ok(session.repository, [
      "ls-tree",
      "-z",
      "--name-only",
      commit,
      "--",
      `${TASKS_DIR}/`,
    ])
  )
    .split("\0")
    .filter((path) => path !== "" && isTaskFileOf(path.slice(path.lastIndexOf("/") + 1), story));
  return listed.length === 1 ? (listed[0] as string) : null;
}

/**
 * True when an approval of `approved` carries to `head` (0019 section 6): `approved` lies on the
 * first-parent line below `head`, and every commit above it on that line is a clean merge dipo
 * recorded (`merges`) or a commit that changes only `taskFile`.
 */
export async function approvalCarries(
  session: GitSession,
  input: {
    readonly approved: string;
    readonly head: string;
    readonly taskFile: string;
    readonly merges: ReadonlySet<string>;
  },
): Promise<boolean> {
  if (input.approved === input.head) return true;
  const repo = session.repository;
  const ancestor = await session.step(repo, [
    "merge-base",
    "--is-ancestor",
    input.approved,
    input.head,
  ]);
  if (ancestor.code !== 0) return false;
  const lines = (
    await session.ok(repo, [
      "rev-list",
      "--first-parent",
      "--parents",
      `${input.approved}..${input.head}`,
    ])
  )
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  for (const line of lines) {
    const [commit = "", ...parents] = line.trim().split(" ");
    if (input.merges.has(commit)) continue;
    if (parents.length !== 1) return false;
    const changed = (
      await session.ok(repo, [
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        parents[0] as string,
        commit,
      ])
    )
      .split("\0")
      .filter((path) => path !== "");
    if (changed.some((path) => path !== input.taskFile)) return false;
  }
  const last = (lines.at(-1) as string).trim().split(" ");
  return last[1] === input.approved;
}

// ---- the service ---------------------------------------------------------------------------------

/** What the check at done decided (`StoryConflicts.atDone`). */
export type DoneConflictDecision =
  /** On to In Review at `tip`: the last part's commit, or the clean merge on top of it. */
  | { readonly kind: "go"; readonly tip: string }
  /** The worker's next message; the story stays In Progress. */
  | { readonly kind: "feedback"; readonly text: string }
  | {
      readonly kind: "park";
      readonly reason: "conflict" | "scope-violation";
      readonly cause: string;
      readonly detail: string;
    }
  /** The run stopped going on meanwhile; that decision stands. */
  | { readonly kind: "stopped" };

export interface StoryConflictsDeps {
  readonly clock: { now(): number };
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /**
   * The sync of a box run in its held turn (`BoxCollisions.syncInTurn`); without it no sync runs
   * at done, only the marker check.
   */
  readonly sync?: (runId: string, mode: SyncMode) => Promise<SyncOutcome>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StoryConflicts {
  readonly #deps: StoryConflictsDeps;

  constructor(deps: StoryConflictsDeps) {
    this.#deps = deps;
  }

  /**
   * The check at done of a box run (see the file comment), in the run's held turn of parts after
   * the last part at `tip`, before its end is claimed. `capped`: the done turn crossed a run cap,
   * so no turn is left for feedback.
   */
  async atDone(input: {
    readonly office: OfficeHandle;
    readonly run: StoredRun;
    readonly tip: string;
    readonly capped: boolean;
  }): Promise<DoneConflictDecision> {
    const { office, run, tip } = input;
    const officeId = office.officeId as OfficeId;
    const git = this.#deps.git(officeId);
    if (git === undefined || run.branch === null || run.story === null) {
      return { kind: "go", tip };
    }
    // 1. What the tip has not resolved of dipo's conflicted merges into this branch, by this run
    // or one before it on the same branch (DIPO-291, DIPO-149).
    const merges = storyMerges(office, run.runId).filter((row) => row.conflicts.length > 0);
    if (merges.length > 0) {
      const left = await git.run((session) => unresolvedAt(session, tip, merges));
      if (left.markers.size > 0 || left.unchanged.length > 0) {
        return this.#markersLeft(office, run, tip, left, input.capped);
      }
    }
    this.#write(office, () => {
      const state = handOffState(office, run.runId);
      if (state.open) {
        appendHandOff(office, run.runId, { kind: "resolved", n: state.current }, this.#now());
      }
      return [];
    });
    // 2. The fetch and the sync before In Review (0019 section 10).
    const sync = this.#deps.sync;
    if (sync === undefined) return { kind: "go", tip };
    const fetched = await git.fetch();
    if (!fetched.ok) {
      this.#deps.warn?.("the fetch before In Review failed; dipo checks against the base it has", {
        run: run.runId,
        reason: fetched.error.message,
      });
    }
    const outcome = await sync(run.runId, this.#riskier(office, run) ? "always" : "onConflict");
    switch (outcome.kind) {
      case "none":
        return { kind: "go", tip };
      case "stopped":
        return { kind: "stopped" };
      case "park":
        return { kind: "park", ...outcome.park };
      case "merged":
        if (outcome.item === null) return { kind: "go", tip: outcome.head };
        if (input.capped) {
          // No turn is left to hand the conflict over: the merge waits in the box and on the branch.
          const cap = conflictCapOf(office, run, this.#fallbackCap(officeId));
          return {
            kind: "park",
            ...capPark(
              outcome.merged.conflicts.map((file) => file.path),
              handOffState(office, run.runId).failed,
              cap,
              true,
            ),
          };
        }
        return { kind: "feedback", text: outcome.item.text };
    }
  }

  /**
   * A merge dipo made into the run's branch (`BoxCollisions` `recorded`): recorded, a conflicted
   * one starts a hand-off, and a clean one may carry the run's approval to the new head.
   */
  async recorded(run: PartRun, merged: CatchUpMerged): Promise<void> {
    const office = this.#deps.offices.get(run.office);
    if (office === undefined) return;
    this.#write(office, () => {
      const at = this.#now();
      recordCatchUp(
        office,
        run.runId,
        {
          kind: "merged",
          base: merged.base,
          onto: merged.onto,
          tip: merged.tip,
          commit: merged.commit,
          conflicts: merged.conflicts,
        },
        at,
      );
      if (merged.conflicts.length > 0) {
        const n = handOffState(office, run.runId).current + 1;
        appendHandOff(office, run.runId, { kind: "start", n, commit: merged.commit }, at);
      }
      return [];
    });
    if (merged.conflicts.length === 0) {
      await this.#carry(office, run).catch((error: unknown) => {
        this.#deps.warn?.(
          "carrying an approval over a clean merge failed; the head gets a review",
          {
            run: run.runId,
            reason: messageOf(error),
          },
        );
      });
    }
  }

  /**
   * A conflict the poll found while the story is In Review (`BoxCollisions` `found`): recorded and
   * told once per base commit, shown on the story detail, merged at the next sync.
   */
  found(run: PartRun, found: CatchUpFound): void {
    const office = this.#deps.offices.get(run.office);
    if (office === undefined) return;
    this.#write(office, () => {
      const last = catchUpsOf(office, run.runId).at(-1);
      if (last?.kind === "found" && last.onto === found.onto && last.tip === found.tip) return [];
      recordCatchUp(office, run.runId, { kind: "found", ...found, commit: null }, this.#now());
      const stored = findRun(office, run.runId as RunId);
      const paths = found.conflicts.map((file) => file.path);
      return [
        {
          type: "engine.notice",
          ...(stored?.key == null ? {} : { key: stored.key }),
          run: run.runId as RunId,
          delta: {
            level: "warn",
            code: CONFLICT_NOTICES.inReview,
            text: `${run.story} is In Review, and ${found.base} at ${found.onto.slice(0, 12)} conflicts with its branch in ${shownPaths(paths)}. dipo merges the base at the story's next In Review or merge-slot sync and hands the conflict to its worker then.`,
          },
        },
      ];
    });
  }

  /**
   * A conflict cleared: a later check of the story In Review found none, so the conflict it found
   * before no longer shows (`BoxCollisions` `cleared`).
   */
  cleared(run: PartRun): void {
    const office = this.#deps.offices.get(run.office);
    if (office === undefined) return;
    this.#write(office, () => {
      office.run(
        "delete from catch_ups where office_id = $office_id and run_id = $run and kind = 'found'",
        { run: run.runId },
      );
      return [];
    });
  }

  /** What is left unresolved at done: a feedback turn, a failed hand-off, or the park at the cap. */
  #markersLeft(
    office: OfficeHandle,
    run: StoredRun,
    tip: string,
    left: Unresolved,
    capped: boolean,
  ): DoneConflictDecision {
    const paths = [
      ...new Set([...left.markers.keys(), ...left.unchanged.map((f) => f.path)]),
    ].toSorted();
    const text = markersLeftText(left.markers, left.unchanged);
    const cap = conflictCapOf(office, run, this.#fallbackCap(office.officeId as OfficeId));
    let decision: DoneConflictDecision = { kind: "feedback", text };
    this.#write(office, () => {
      const at = this.#now();
      const state = handOffState(office, run.runId);
      const fail = (): number => {
        appendHandOff(office, run.runId, { kind: "failed", n: state.current, why: "markers" }, at);
        return state.failed + 1;
      };
      if (capped) {
        // A done turn that crossed a run cap has no turn left for the feedback.
        decision = {
          kind: "park",
          ...capPark(paths, state.open ? fail() : state.failed, cap, true),
        };
        return [];
      }
      if (!state.open) {
        // Markers on the tip with no open hand-off (a resolved one, edited again): a new one.
        appendHandOff(office, run.runId, { kind: "start", n: state.current + 1, commit: tip }, at);
        return [];
      }
      if (!state.feedback) {
        appendHandOff(office, run.runId, { kind: "feedback", n: state.current }, at);
        return [];
      }
      const failed = fail();
      if (failed >= cap) {
        decision = { kind: "park", ...capPark(paths, failed, cap) };
        return [];
      }
      appendHandOff(office, run.runId, { kind: "start", n: state.current + 1, commit: tip }, at);
      return [];
    });
    return decision;
  }

  /** The approval of the run carried to its branch head after a clean merge (0019 section 6). */
  async #carry(office: OfficeHandle, run: PartRun): Promise<void> {
    const stored = findRun(office, run.runId as RunId);
    if (stored === null || stored.key === null) return;
    const verdict = lastReviewVerdict(office, run.runId as RunId);
    if (verdict === null || verdict.verdict !== "approved") return;
    const git = this.#deps.git(run.office);
    if (git === undefined) return;
    const merges = new Set(
      catchUpsOf(office, run.runId)
        .filter((row) => row.kind === "merged" && row.conflicts.length === 0)
        .map((row) => row.commit as string),
    );
    const carried = await git.run(async (session) => {
      const head = (
        await session.ok(session.repository, [
          "rev-parse",
          "--verify",
          `refs/heads/${run.branch}^{commit}`,
        ])
      ).trim();
      const taskFile = await taskFileAt(session, head, run.story);
      if (taskFile === null) return null;
      const carries = await approvalCarries(session, {
        approved: verdict.commit,
        head,
        taskFile,
        merges,
      });
      if (!carries) return null;
      const tree = await session.ok(session.repository, ["ls-tree", "-r", "-z", head]);
      return { head, key: codeTreeKeyOf(tree, taskFile) };
    });
    if (carried === null) return;
    this.#write(office, () => {
      if (reviewVerdictForTree(office, run.runId as RunId, carried.key) !== null) return [];
      const at = this.#now();
      const recorded = recordReviewVerdict(office, this.#deps.ids, {
        runId: run.runId as RunId,
        key: stored.key as StoryKey,
        round: verdict.round,
        agent: null,
        model: verdict.model,
        commit: carried.head,
        codeTreeKey: carried.key,
        judged: {
          verdict: "approved",
          criteria: verdict.criteria,
          findings: verdict.findings,
          summary: verdict.summary,
          notes: verdict.notes,
        },
        carriedFrom: verdict.commit,
        at,
      });
      return [
        reviewDecidedEntry(recorded),
        {
          type: "engine.notice",
          key: stored.key as StoryKey,
          run: run.runId as RunId,
          delta: {
            level: "info",
            code: CONFLICT_NOTICES.carried,
            text: `${run.story}: the review approval of ${verdict.commit.slice(0, 12)} carries to ${carried.head.slice(0, 12)}, since only dipo's clean merge of the base and task-file commits lie between them; no new review round.`,
          },
        },
      ];
    });
  }

  /** A story of tier L or flagged test-before-merge (0010 open question 3, 0019 section 10). */
  #riskier(office: OfficeHandle, run: StoredRun): boolean {
    if (run.tier === "L") return true;
    if (run.key === null) return false;
    const row = office.get<{ labels: string }>(
      "select labels from backlog_mirror where office_id = $office_id and key = $key",
      { key: run.key },
    );
    if (row === null) return false;
    try {
      const labels = JSON.parse(row.labels) as unknown;
      return Array.isArray(labels) && labels.includes(TEST_BEFORE_MERGE);
    } catch {
      return false;
    }
  }

  #fallbackCap(officeId: OfficeId): number {
    return this.#deps.offices.config(officeId)?.mergeSlot.conflictAttempts ?? CONFLICT_CAP_DEFAULT;
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    const at = this.#now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId as OfficeId);
  }
}
