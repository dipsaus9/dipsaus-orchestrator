// The story PRs (migration 36; 0019 section 16). Every statement binds the office through its
// handle; writes run inside the caller's transaction.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { IN_REVIEW_END, REVIEWED_END } from "../run/records";

export type StoryPrState = "open" | "merged" | "closed";

export interface StoryPrRecord {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  /** The head commit last pushed to the PR. */
  readonly headSha: string;
  readonly state: StoryPrState;
  readonly title: string;
  readonly bodyHash: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  /** The number of the closed PR of the run this one replaces (migration 52, DIPO-324). */
  readonly replaces?: number | null;
}

interface PrRow {
  run_id: string;
  key: string;
  pr_number: number;
  url: string;
  branch: string;
  base: string;
  head_sha: string;
  state: StoryPrState;
  title: string;
  body_hash: string;
  opened_at: number;
  closed_at: number | null;
  replaces: number | null;
}

const COLUMNS = `run_id, key, pr_number, url, branch, base, head_sha, state, title, body_hash,
  opened_at, closed_at, replaces`;

function toRecord(row: PrRow): StoryPrRecord {
  return {
    runId: row.run_id as RunId,
    key: row.key as StoryKey,
    number: row.pr_number,
    url: row.url,
    branch: row.branch,
    base: row.base,
    headSha: row.head_sha,
    state: row.state,
    title: row.title,
    bodyHash: row.body_hash,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    replaces: row.replaces,
  };
}

/** The PR of a run, or null while it has none. */
export function findStoryPr(office: OfficeHandle, runId: RunId): StoryPrRecord | null {
  const row = office.get<PrRow>(
    `select ${COLUMNS} from story_prs where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null ? null : toRecord(row);
}

/** The newest PR of a story, or null. */
export function latestStoryPr(office: OfficeHandle, key: string): StoryPrRecord | null {
  const row = office.get<PrRow>(
    `select ${COLUMNS} from story_prs where office_id = $office_id and key = $key
      order by opened_at desc, rowid desc limit 1`,
    { key },
  );
  return row === null ? null : toRecord(row);
}

export function insertStoryPr(office: OfficeHandle, record: StoryPrRecord): void {
  office.run(
    `insert into story_prs (office_id, run_id, key, pr_number, url, branch, base, head_sha, state,
        title, body_hash, opened_at, closed_at, replaces)
       values ($office_id, $run, $key, $number, $url, $branch, $base, $head, $state, $title,
        $hash, $opened, $closed, $replaces)`,
    {
      run: record.runId,
      key: record.key,
      number: record.number,
      url: record.url,
      branch: record.branch,
      base: record.base,
      head: record.headSha,
      state: record.state,
      title: record.title,
      hash: record.bodyHash,
      opened: record.openedAt,
      closed: record.closedAt,
      replaces: record.replaces ?? null,
    },
  );
}

/**
 * The run's closed PR replaced in place by the new one `record` (DIPO-324): one row per run, the
 * new PR's facts, `replaces` naming the closed one.
 */
export function replaceStoryPr(office: OfficeHandle, record: StoryPrRecord): void {
  office.run(
    `update story_prs set key = $key, pr_number = $number, url = $url, branch = $branch,
        base = $base, head_sha = $head, state = $state, title = $title, body_hash = $hash,
        opened_at = $opened, closed_at = $closed, replaces = $replaces
      where office_id = $office_id and run_id = $run`,
    {
      run: record.runId,
      key: record.key,
      number: record.number,
      url: record.url,
      branch: record.branch,
      base: record.base,
      head: record.headSha,
      state: record.state,
      title: record.title,
      hash: record.bodyHash,
      opened: record.openedAt,
      closed: record.closedAt,
      replaces: record.replaces ?? null,
    },
  );
}

/**
 * Runs whose story PR was closed on the host and that the maintainer resumed from a `by-maintainer`
 * park made after the PR opened, with a live claim: a new PR is still to open for them (DIPO-324), so a
 * create that failed is tried again by the PR poll. Oldest first. It reads a resolved park's reason,
 * which is history (0007), never the current reason (DIPO-360).
 */
export function pendingPrReplacements(office: OfficeHandle): RunId[] {
  return office
    .all<{ run_id: string }>(
      `select p.run_id from story_prs p
        where p.office_id = $office_id and p.state = 'closed'
          and exists (select 1 from parks k where k.office_id = p.office_id
            and k.run_id = p.run_id and k.reason = 'by-maintainer' and k.resolved_how = 'resume'
            and k.at >= p.opened_at)
          and exists (select 1 from claims c where c.office_id = p.office_id
            and c.run_id = p.run_id and c.released_at is null)
        order by p.closed_at, p.rowid`,
    )
    .map((row) => row.run_id as RunId);
}

/** Records the head, title and body hash last written to the PR. */
export function updateStoryPr(
  office: OfficeHandle,
  runId: RunId,
  change: { headSha: string; title: string; bodyHash: string },
): void {
  office.run(
    `update story_prs set head_sha = $head, title = $title, body_hash = $hash
      where office_id = $office_id and run_id = $run`,
    { run: runId, head: change.headSha, title: change.title, hash: change.bodyHash },
  );
}

/**
 * Records the PR's state on the host and when the engine saw it close or merge (null while it is
 * open).
 */
export function setStoryPrState(
  office: OfficeHandle,
  runId: RunId,
  change: { state: StoryPrState; closedAt: number | null },
): void {
  office.run(
    `update story_prs set state = $state, closed_at = $closed
      where office_id = $office_id and run_id = $run`,
    { run: runId, state: change.state, closed: change.closedAt },
  );
}

/** The PRs that were open when the engine last looked, oldest first. */
export function openStoryPrs(office: OfficeHandle): StoryPrRecord[] {
  return office
    .all<PrRow>(
      `select ${COLUMNS} from story_prs where office_id = $office_id and state = 'open'
        order by opened_at, rowid`,
    )
    .map(toRecord);
}

/** The Backlog.md status of a story at In Review (0012). */
const IN_REVIEW_STATUS = "In Review";

/**
 * Runs whose PR is still to open, oldest first: a story run that ended at In Review, or as reviewed
 * (DIPO-152: its review finished while story PRs were off), and has no
 * `story_prs` row, whose story is In Review now (not removed, a task at status In Review) and
 * whose claim is live with its In Review push on the remote. The In Review push records
 * `claims.pushed_at` in the transaction that ends the run (`run/verify-commit.ts`), so a push at
 * or after the run's end is that push; an earlier one is the claim push. Not one: a run of a story
 * that is Done (a run from before DIPO-142 keeps the end kind `in-review` after Done), whose claim
 * was released, or whose In Review push never reached the remote.
 */
export function runsWithoutPr(office: OfficeHandle): { runId: RunId; key: StoryKey }[] {
  return office
    .all<{ run_id: string; key: string }>(
      `select r.run_id as run_id, r.key as key from runs r
        where r.office_id = $office_id and r.kind = 'story'
          and r.end_kind in ($end, $reviewed)
          and r.key is not null and r.branch is not null
          and not exists (select 1 from story_prs p
            where p.office_id = r.office_id and p.run_id = r.run_id)
          and exists (select 1 from stories s
            join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
            where s.office_id = r.office_id and s.key = r.key and s.removed_at is null
              and m.kind = 'task' and m.status = $status)
          and exists (select 1 from claims c
            where c.office_id = r.office_id and c.run_id = r.run_id and c.released_at is null
              and c.pushed_at is not null
              and (c.pushed_at >= r.ended_at
                or (r.end_kind = $reviewed and exists (select 1 from review_verdicts v
                  where v.office_id = r.office_id and v.run_id = r.run_id))))
        order by r.ended_at, r.run_id`,
      { end: IN_REVIEW_END, reviewed: REVIEWED_END, status: IN_REVIEW_STATUS },
    )
    .map((row) => ({ runId: row.run_id as RunId, key: row.key as StoryKey }));
}

/** True when the story `key` is a task at status In Review now, not removed. */
export function storyInReview(office: OfficeHandle, key: string): boolean {
  return (
    office.get(
      `select 1 as found from stories s
        join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
        where s.office_id = $office_id and s.key = $key and s.removed_at is null
          and m.kind = 'task' and m.status = $status`,
      { key, status: IN_REVIEW_STATUS },
    ) !== null
  );
}

/** True when the run has a park row (written by `parkStory`). */
export function runParked(office: OfficeHandle, runId: RunId): boolean {
  return (
    office.get("select 1 as found from parks where office_id = $office_id and run_id = $run", {
      run: runId,
    }) !== null
  );
}

/**
 * True when the run recorded that no CI ran for the pushed head `head` (a `ci-none` step,
 * DIPO-299): the host reported no check at all for that head of a box run within the bounded wait,
 * so nothing waits for CI on it and the review decides.
 */
export function noCiRan(office: OfficeHandle, runId: RunId, head: string): boolean {
  return (
    office.get(
      `select 1 as found from run_steps where office_id = $office_id and run_id = $run
        and kind = 'ci-none' and value = $head limit 1`,
      { run: runId, head },
    ) !== null
  );
}

/** What one push of a story branch did, as `pushBranch` reports it. */
export interface BranchPush {
  readonly pushed: boolean;
  /** Why it failed; null with `pushed` false means the office has no remote. */
  readonly error: string | null;
}

/**
 * Inside the caller's transaction (DIPO-315): records a push of the story branch `branch` on its
 * live claim. One that reached the remote sets `claims.pushed_at`; one that found no remote sets
 * `claims.no_remote_at`, so a review does not wait for a remote the office does not have. A failed
 * push records nothing: the PR poll pushes again (`runsToPush`). Every story-branch push dipo makes
 * records here, so `pushed_at` at or after a run's end means its head is on the remote.
 */
export function recordBranchPush(
  office: OfficeHandle,
  branch: string,
  push: BranchPush,
  at: number,
): void {
  if (!push.pushed && push.error !== null) return;
  office.run(
    `update claims set ${push.pushed ? "pushed_at" : "no_remote_at"} = $at
      where office_id = $office_id and branch = $branch and released_at is null`,
    { branch, at },
  );
}

/** A run whose In Review head may not be on the remote (`runsToPush`). */
export interface UnpushedRun {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly branch: string;
}

/**
 * Runs to push again (DIPO-315), oldest first: story runs that ended at In Review with a live claim
 * whose `pushed_at` is null or earlier than the run's end, so the In Review push did not reach the
 * remote, while the story is In Review now. A reviewed run is never one: its review started only
 * once its head was on the remote (`pendingReviews`), and the review period moves its end past
 * that push without a push of its own. Nor is a run whose office was found to have no remote at or
 * after its end (`no_remote_at`): nothing waits for that push.
 */
export function runsToPush(office: OfficeHandle): UnpushedRun[] {
  return office
    .all<{ run_id: string; key: string; branch: string }>(
      `select r.run_id as run_id, r.key as key, r.branch as branch from runs r
        join claims c on c.office_id = r.office_id and c.run_id = r.run_id
          and c.released_at is null
        where r.office_id = $office_id and r.kind = 'story'
          and r.end_kind = $end and r.ended_at is not null
          and r.key is not null and r.branch is not null
          and (c.pushed_at is null or c.pushed_at < r.ended_at)
          and (c.no_remote_at is null or c.no_remote_at < r.ended_at)
          and exists (select 1 from stories s
            join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
            where s.office_id = r.office_id and s.key = r.key and s.removed_at is null
              and m.kind = 'task' and m.status = $status)
        order by r.ended_at, r.run_id`,
      { end: IN_REVIEW_END, status: IN_REVIEW_STATUS },
    )
    .map((row) => ({
      runId: row.run_id as RunId,
      key: row.key as StoryKey,
      branch: row.branch,
    }));
}
