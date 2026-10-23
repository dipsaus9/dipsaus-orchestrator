// The open feedback of a run's handoff (0020 section 6, DIPO-154): the run's feedback items that a
// later green verify or approval has not answered yet, read with their text from 0019's
// `feedback_items` (DIPO-148). A new session of the run lists them in its handoff block, so a fix
// round, a CI failure or a conflict the previous session left open reaches the next one.
//
// Each source is answered by its own kind of fact, stored at or after the item (`ANSWERED_BY`):
// - `verify`, `ci` and `conflict` items by a green verify of the run (`verify_results`, passed:
//   the local verify of a Mac run, which also runs after a conflict hand-off) or a green CI head.
//   Green CI is not stored yet (the story PR poll keeps it in memory, and dipo runs no verify in a
//   box run, 0021 amendment of 2026-10-22), so a box run's CI item stays listed until a store of
//   green heads answers it.
// - `review` and `reject` items by an approving review verdict of the run (`review_verdicts`,
//   approved) or a maintainer override past a blocked one. A green verify answers no finding.
// An item of a source this does not know is never answered here, so it stays listed.
//
// `feedback_items` arrives with DIPO-148's migration. Until it exists this reads no items, so a
// database without it lists no open feedback instead of failing the handoff.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** One stored feedback item as the handoff reads it. */
export interface StoredFeedback {
  /** `verify`, `ci`, `review`, `conflict` or `reject` (0019 section 8). */
  readonly source: string;
  /** The pushed head the item was found on. */
  readonly head: string;
  /** The rendered item text, at most 3,000 characters. */
  readonly text: string;
  readonly createdAt: number;
}

/** The kinds of fact that answer a feedback item. */
export type AnswerKind = "green" | "approval";

/** Which kind of fact answers an item of each source (0019 section 8). */
export const ANSWERED_BY: Readonly<Record<string, AnswerKind>> = {
  verify: "green",
  ci: "green",
  conflict: "green",
  review: "approval",
  reject: "approval",
};

/** The newest answering fact of each kind a run has stored; null when it has none. */
export interface RunAnswers {
  /** The newest green verify (or, once stored, green CI head). */
  readonly green: number | null;
  /** The newest approving verdict or maintainer override. */
  readonly approval: number | null;
}

/** True when the office database has the table `name`. */
export function hasTable(office: OfficeHandle, name: string): boolean {
  // `$office_id` only satisfies the office handle's binding rule; the schema is the connection's.
  return (
    office.get<{ name: string }>(
      `select name from sqlite_master where type = 'table' and name = $name
        and $office_id is not null`,
      { name },
    ) !== null
  );
}

/** The run's stored feedback items, oldest first; none before `feedback_items` exists. */
export function storedFeedbackOf(office: OfficeHandle, runId: RunId | string): StoredFeedback[] {
  if (!hasTable(office, "feedback_items")) return [];
  return office
    .all<{ source: string; head_sha: string; text: string; created_at: number }>(
      `select source, head_sha, text, created_at from feedback_items
        where office_id = $office_id and run_id = $run order by item_id`,
      { run: runId },
    )
    .map((row) => ({
      source: row.source,
      head: row.head_sha,
      text: row.text,
      createdAt: row.created_at,
    }));
}

/** The run's newest green verify and newest approval or override. */
export function runAnswers(office: OfficeHandle, runId: RunId | string): RunAnswers {
  const green =
    office.get<{ at: number | null }>(
      `select max(at) as at from verify_results
        where office_id = $office_id and run_id = $run and passed = 1`,
      { run: runId },
    )?.at ?? null;
  const approval =
    office.get<{ at: number | null }>(
      `select max(case when verdict = 'approved' then decided_at else override_at end) as at
        from review_verdicts
        where office_id = $office_id and run_id = $run
          and (verdict = 'approved' or override_at is not null)`,
      { run: runId },
    )?.at ?? null;
  return { green, approval };
}

/** True when a fact of the kind that answers `item` was stored at or after it. */
export function answered(item: StoredFeedback, answers: RunAnswers): boolean {
  const kind = ANSWERED_BY[item.source];
  const at = kind === undefined ? null : answers[kind];
  return at !== null && at >= item.createdAt;
}

/** The run's feedback items that no later fact of their own kind answered, oldest first. */
export function openFeedbackOf(office: OfficeHandle, runId: RunId | string): StoredFeedback[] {
  const answers = runAnswers(office, runId);
  return storedFeedbackOf(office, runId).filter((item) => !answered(item, answers));
}
