// The office's backlog PRs and the stories a failed check blocks (migration 15). Every statement
// binds the office through its handle; writes run inside the caller's transaction.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../db/office";

import type { CheckFailure } from "./check";

export type BacklogPrState = "open" | "merged" | "closed";
export type CheckState = "pending" | "passed" | "failed";

export interface BacklogPrRecord {
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly title: string;
  readonly state: BacklogPrState;
  /** The head commit the last check ran on, or null before the first. */
  readonly checkedHead: string | null;
  /** The base commit the last check diffed the head against, or null before the first. */
  readonly checkedBase: string | null;
  /** Why the last check could not run, until a check runs again; null otherwise. */
  readonly checkError: string | null;
  readonly check: CheckState;
  readonly failures: readonly CheckFailure[];
  /** The keys of the tasks the last check saw changed. */
  readonly touched: readonly StoryKey[];
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly checkedAt: number | null;
  readonly closedAt: number | null;
}

interface PrRow {
  pr_number: number;
  url: string;
  branch: string;
  title: string;
  state: BacklogPrState;
  checked_head: string | null;
  checked_base: string | null;
  check_error: string | null;
  check_state: CheckState;
  failures: string;
  touched: string;
  opened_at: number;
  updated_at: number;
  checked_at: number | null;
  closed_at: number | null;
}

const COLUMNS = `pr_number, url, branch, title, state, checked_head, checked_base, check_error,
  check_state, failures, touched, opened_at, updated_at, checked_at, closed_at`;

function toRecord(row: PrRow): BacklogPrRecord {
  return {
    number: row.pr_number,
    url: row.url,
    branch: row.branch,
    title: row.title,
    state: row.state,
    checkedHead: row.checked_head,
    checkedBase: row.checked_base,
    checkError: row.check_error,
    check: row.check_state,
    failures: JSON.parse(row.failures) as CheckFailure[],
    touched: JSON.parse(row.touched) as StoryKey[],
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    checkedAt: row.checked_at,
    closedAt: row.closed_at,
  };
}

/** Records a PR the engine opened (or found open for its branch) as open and not yet checked. */
export function insertPr(
  office: OfficeHandle,
  pr: { number: number; url: string; branch: string; title: string },
  now: number,
): void {
  office.run(
    `insert into backlog_prs (office_id, pr_number, url, branch, title, state, checked_head,
       check_state, failures, touched, opened_at, updated_at)
     values ($office_id, $number, $url, $branch, $title, 'open', null, 'pending', '[]', '[]',
       $now, $now)
     on conflict (office_id, pr_number) do update set
       state = 'open', title = excluded.title, updated_at = excluded.updated_at, closed_at = null`,
    { number: pr.number, url: pr.url, branch: pr.branch, title: pr.title, now },
  );
}

export function findPr(office: OfficeHandle, number: number): BacklogPrRecord | null {
  const row = office.get<PrRow>(
    `select ${COLUMNS} from backlog_prs where office_id = $office_id and pr_number = $number`,
    { number },
  );
  return row === null ? null : toRecord(row);
}

/** The office's open backlog PRs, oldest first. */
export function openPrs(office: OfficeHandle): BacklogPrRecord[] {
  return office
    .all<PrRow>(
      `select ${COLUMNS} from backlog_prs where office_id = $office_id and state = 'open'
       order by opened_at, pr_number`,
    )
    .map(toRecord);
}

export function setTitle(office: OfficeHandle, number: number, title: string, now: number): void {
  office.run(
    `update backlog_prs set title = $title, updated_at = $now
     where office_id = $office_id and pr_number = $number`,
    { number, title, now },
  );
}

/** Stores a check result for the head it ran on and the base it diffed against. */
export function recordCheck(
  office: OfficeHandle,
  number: number,
  result: {
    head: string;
    base: string;
    passed: boolean;
    failures: readonly CheckFailure[];
    touched: readonly StoryKey[];
  },
  now: number,
): void {
  office.run(
    `update backlog_prs set checked_head = $head, checked_base = $base, check_error = null, check_state = $state, failures = $failures,
       touched = $touched, checked_at = $now, updated_at = $now
     where office_id = $office_id and pr_number = $number`,
    {
      number,
      head: result.head,
      base: result.base,
      state: result.passed ? "passed" : "failed",
      failures: JSON.stringify(result.failures),
      touched: JSON.stringify(result.touched),
      now,
    },
  );
}

/**
 * Records why a check could not run. Returns true when the cause is new for this PR (the caller
 * then shows a notice), false when the last failed check had the same cause.
 */
export function recordCheckError(
  office: OfficeHandle,
  number: number,
  reason: string,
  now: number,
): boolean {
  return (
    office.run(
      `update backlog_prs set check_error = $reason, updated_at = $now
       where office_id = $office_id and pr_number = $number
         and (check_error is null or check_error != $reason)`,
      { number, reason, now },
    ).changes > 0
  );
}

export function closePrRecord(
  office: OfficeHandle,
  number: number,
  state: "merged" | "closed",
  now: number,
): void {
  office.run(
    `update backlog_prs set state = $state, closed_at = $now, updated_at = $now
     where office_id = $office_id and pr_number = $number`,
    { number, state, now },
  );
}

/**
 * True when the backlog PR may be merged by the engine (DIPO-73): it is open and the structural
 * check passed on exactly `head`. A failed check, or a head the check has not seen, is not.
 */
export function backlogPrMergeable(office: OfficeHandle, number: number, head: string): boolean {
  const pr = findPr(office, number);
  return pr !== null && pr.state === "open" && pr.check === "passed" && pr.checkedHead === head;
}

/** Blocks each of `keys` for the merged PR `number`, with the failures that name it. */
export function blockStories(
  office: OfficeHandle,
  number: number,
  blocks: readonly { key: StoryKey; failures: readonly CheckFailure[] }[],
  now: number,
): void {
  for (const block of blocks) {
    office.run(
      `insert into backlog_pr_blocks (office_id, key, pr_number, failures, blocked_at)
       values ($office_id, $key, $number, $failures, $now)
       on conflict (office_id, key, pr_number) do update set
         failures = excluded.failures, cleared_at = null, cleared_by = null`,
      { key: block.key, number, failures: JSON.stringify(block.failures), now },
    );
  }
}

/** Clears the blocks of `keys` set by an earlier PR than `number`: that PR fixed them. */
export function clearBlocks(
  office: OfficeHandle,
  number: number,
  keys: readonly StoryKey[],
  now: number,
): number {
  let cleared = 0;
  for (const key of keys) {
    cleared += office.run(
      `update backlog_pr_blocks set cleared_at = $now, cleared_by = $number
       where office_id = $office_id and key = $key and cleared_at is null and pr_number != $number`,
      { key, number, now },
    ).changes;
  }
  return cleared;
}

/** Why `work.run` skips a story: a merged backlog PR failed its check on it. */
export interface BacklogCheckBlock {
  readonly reason: "notRunnable";
  /** The merged backlog PRs whose failed check blocks the story, oldest first. */
  readonly prs: readonly number[];
  readonly failures: readonly CheckFailure[];
}

/**
 * Reports a story a merged backlog PR failed its structural check on, until a later backlog PR
 * that touches it merges with a passing check (0010 section 2). `work.run` and the pickup re-check
 * (DIPO-48) skip such a story as `notRunnable`.
 */
export function backlogCheckBlocked(office: OfficeHandle, key: StoryKey): BacklogCheckBlock | null {
  const rows = office.all<{ pr_number: number; failures: string }>(
    `select pr_number, failures from backlog_pr_blocks
     where office_id = $office_id and key = $key and cleared_at is null
     order by blocked_at, pr_number`,
    { key },
  );
  if (rows.length === 0) return null;
  return {
    reason: "notRunnable",
    prs: rows.map((row) => row.pr_number),
    failures: rows.flatMap((row) => JSON.parse(row.failures) as CheckFailure[]),
  };
}
