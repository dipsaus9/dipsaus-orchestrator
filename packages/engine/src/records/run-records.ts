// Run facts (0007 section 4, DIPO-48): rows of `runs`, `run_steps` and `config_snapshots`, read and
// written through the office handle. Writers run inside the caller's `office.immediate`.
//
// This module is the one writer of `runs` (0001): every insert and update of a run row goes
// through it, and `test/run/one-writer.test.ts` fails on one anywhere else. A change of the run's
// state (its active period, ending, wait and parked time) is decided by `nextRunState` (`lifecycle.ts`)
// and written by `applyRunEvent`.
//
// A story run is active while it has not ended and its claim is live, so a claim released by
// teardown or a rollback never leaves an office busy; a session run is active until it ends.
//
// One story run spans every round of its claim (0019 section 13, DIPO-142): its active period ends
// at a park and at In Review, and `reopen` (`run-state/rounds.ts`) makes it active again for a
// resume, a review, a fix round or a conflict hand-off, adding the time it stood ended to
// `parked_ms`. A run ends done, parked or dropped (0020, `lifecycle.ts`); at In Review it stays
// open. Each end writes its `run_outcomes` row, provisional until Done writes the final one.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { parseSafeChainRecord, type SafeChainRecord } from "../box/safe-chain";
import { appendEntries } from "../changelog/log";
import { canonicalJson } from "../config/merge";
import type { OfficeHandle } from "../db/office";

import { runTotals } from "./caps";
import { nextRunState, type RunEnd, type RunEvent, type RunState } from "./lifecycle";
import { retiredRun } from "./retired";
import { finalizeRunAgents } from "./usage";

export type RunKind = "story" | "session";

/** What a run starts with (0007 section 4). Story fields are null for a session run. */
export interface NewRun {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly key: StoryKey | null;
  readonly story: string | null;
  readonly tier: string | null;
  readonly role: string;
  readonly model: string;
  readonly startSha: string | null;
  readonly branch: string | null;
  readonly budgetUnit: string;
  readonly budgetLimit: number;
  readonly loopCap: number;
  /** The turn and minute caps at the start (DIPO-143); null for a run started before they were kept. */
  readonly maxTurns?: number | null;
  readonly maxMinutes?: number | null;
  readonly reviewRoundCap: number | null;
  /**
   * The review loop's other caps at the start (0002): red required check heads
   * (`caps.ciAttempts`), failed conflict hand-offs (`caps.conflictAttempts`), and the
   * reviewer's own turn, minute and token caps per session (`review.maxTurns`, `review.maxMinutes`,
   * `review.budgetTokens`), never the story's. Null for a session run and for a run started before
   * they were kept.
   */
  readonly ciCap?: number | null;
  readonly conflictCap?: number | null;
  readonly reviewMaxTurns?: number | null;
  readonly reviewMaxMinutes?: number | null;
  readonly reviewMaxTokens?: number | null;
  readonly configHash: string;
  readonly overrideKeys: readonly string[] | null;
  readonly runProfileId: string | null;
  readonly startedAt: number;
  /** The declared scope (F8) the story run started with; null for a session run (DIPO-49). */
  readonly scope?: readonly string[] | null;
}

export interface StoredRun extends NewRun {
  readonly scope: readonly string[] | null;
  /** Gate commands the story branch changed against the base profile; null when none (DIPO-49). */
  readonly gateChanges: readonly string[] | null;
  /** Safe-Chain's refusals of the run's box sessions (DIPO-376); null before a session marked. */
  readonly safeChain: SafeChainRecord | null;
  /** When its last active period ended; set while it stays open at In Review (`lifecycle.ts`). */
  readonly endedAt: number | null;
  /** How the run ended: done, parked or dropped; null while it is open (0020). */
  readonly ending: RunEnd | null;
  /**
   * Milliseconds the run stood parked before an answer reopened it (DIPO-75, migration 23), and
   * stood ended or in review between its rounds (DIPO-142); its caps and minutes count the time
   * its developer worked, not these. 0 when absent.
   */
  readonly parkedMs?: number;
  /**
   * What the reopened run waits for its place as (`run-state/places.ts`, DIPO-142), with the time
   * it began waiting; null when its session started or it waits for nothing.
   */
  readonly waiting?: string | null;
  readonly waitingSince?: number | null;
}

interface RunRow {
  run_id: string;
  kind: RunKind;
  key: string | null;
  story_id: string | null;
  tier: string | null;
  role: string;
  model: string;
  start_sha: string | null;
  branch: string | null;
  budget_unit: string;
  budget_limit: number;
  loop_cap: number;
  max_turns: number | null;
  max_minutes: number | null;
  review_round_cap: number | null;
  ci_cap: number | null;
  conflict_cap: number | null;
  review_max_turns: number | null;
  review_max_minutes: number | null;
  review_max_tokens: number | null;
  config_hash: string;
  override_keys: string | null;
  run_profile_id: string | null;
  started_at: number;
  scope: string | null;
  gate_changes: string | null;
  safe_chain: string | null;
  ended_at: number | null;
  end_kind: string | null;
  parked_ms: number;
  waiting: string | null;
  waiting_since: number | null;
}

const COLUMNS = `run_id, kind, key, story_id, tier, role, model, start_sha, branch, budget_unit, budget_limit, loop_cap, max_turns, max_minutes, review_round_cap, ci_cap,
  conflict_cap, review_max_turns, review_max_minutes, review_max_tokens, config_hash, override_keys,
  run_profile_id, started_at, scope, gate_changes, ended_at, end_kind, parked_ms, waiting,
  waiting_since, safe_chain`;

/** The columns a run row is inserted with: those a run starts with. */
const INSERTED = COLUMNS.replace(
  /, gate_changes, ended_at, end_kind, parked_ms, waiting,\s+waiting_since, safe_chain$/,
  "",
);

function jsonList(text: string | null): string[] | null {
  return text === null ? null : (JSON.parse(text) as string[]);
}

function toRecord(row: RunRow): StoredRun {
  return {
    runId: row.run_id as RunId,
    kind: row.kind,
    key: row.key as StoryKey | null,
    story: row.story_id,
    tier: row.tier,
    role: row.role,
    model: row.model,
    startSha: row.start_sha,
    branch: row.branch,
    budgetUnit: row.budget_unit,
    budgetLimit: row.budget_limit,
    loopCap: row.loop_cap,
    maxTurns: row.max_turns,
    maxMinutes: row.max_minutes,
    reviewRoundCap: row.review_round_cap,
    ciCap: row.ci_cap,
    conflictCap: row.conflict_cap,
    reviewMaxTurns: row.review_max_turns,
    reviewMaxMinutes: row.review_max_minutes,
    reviewMaxTokens: row.review_max_tokens,
    configHash: row.config_hash,
    overrideKeys: row.override_keys === null ? null : (JSON.parse(row.override_keys) as string[]),
    runProfileId: row.run_profile_id,
    startedAt: row.started_at,
    scope: jsonList(row.scope),
    gateChanges: jsonList(row.gate_changes),
    safeChain: row.safe_chain === null ? null : parseSafeChainRecord(row.safe_chain),
    endedAt: row.ended_at,
    ending: row.end_kind as RunEnd | null,
    parkedMs: row.parked_ms,
    waiting: row.waiting,
    waitingSince: row.waiting_since,
  };
}

export function insertRun(office: OfficeHandle, run: NewRun): void {
  const state = nextRunState(null, { kind: "start" }) as RunState;
  office.run(
    `insert into runs (office_id, ${INSERTED}, ended_at, end_kind, parked_ms, waiting,
       waiting_since)
     values ($office_id, $run_id, $kind, $key, $story_id, $tier, $role, $model, $start_sha,
       $branch, $budget_unit, $budget_limit, $loop_cap, $max_turns,
       $max_minutes, $review_round_cap, $ci_cap, $conflict_cap, $review_max_turns,
       $review_max_minutes, $review_max_tokens, $config_hash, $override_keys, $run_profile_id,
       $started_at, $scope, $ended_at, $end_kind, $parked_ms, $waiting, $waiting_since)`,
    {
      ended_at: state.endedAt,
      end_kind: state.ending,
      parked_ms: state.parkedMs,
      waiting: state.waiting,
      waiting_since: state.waitingSince,
      run_id: run.runId,
      kind: run.kind,
      key: run.key,
      story_id: run.story,
      tier: run.tier,
      role: run.role,
      model: run.model,
      start_sha: run.startSha,
      branch: run.branch,
      budget_unit: run.budgetUnit,
      budget_limit: run.budgetLimit,
      loop_cap: run.loopCap,
      max_turns: run.maxTurns ?? null,
      max_minutes: run.maxMinutes ?? null,
      review_round_cap: run.reviewRoundCap,
      ci_cap: run.ciCap ?? null,
      conflict_cap: run.conflictCap ?? null,
      review_max_turns: run.reviewMaxTurns ?? null,
      review_max_minutes: run.reviewMaxMinutes ?? null,
      review_max_tokens: run.reviewMaxTokens ?? null,
      config_hash: run.configHash,
      override_keys: run.overrideKeys === null ? null : JSON.stringify(run.overrideKeys),
      run_profile_id: run.runProfileId,
      started_at: run.startedAt,
      scope: run.scope == null ? null : JSON.stringify(run.scope),
    },
  );
}

/** Records the gate commands the story branch changed (0013 section 5, DIPO-49 AC #7). */
export function recordGateChanges(
  office: OfficeHandle,
  runId: RunId,
  changes: readonly string[],
): void {
  office.run(
    `update runs set gate_changes = $changes where office_id = $office_id and run_id = $run`,
    { run: runId, changes: changes.length === 0 ? null : JSON.stringify(changes) },
  );
}

/** Keeps the run's Safe-Chain record (DIPO-376), read from the Safe-Chain box's logs. */
export function recordSafeChain(office: OfficeHandle, runId: RunId, record: SafeChainRecord): void {
  office.run(
    `update runs set safe_chain = $record where office_id = $office_id and run_id = $run`,
    { run: runId, record: JSON.stringify(record) },
  );
}

/** The run's web calls by tool, counted from its tool activity (0020, DIPO-164). */
export function countWebCalls(
  office: OfficeHandle,
  runId: string,
  calls: { readonly searches: number; readonly fetches: number },
): void {
  office.run(
    `update runs set web_searches = web_searches + $searches,
       web_fetches = web_fetches + $fetches
     where office_id = $office_id and run_id = $run`,
    { run: runId, searches: calls.searches, fetches: calls.fetches },
  );
}

/** The story's criteria at run start, as sorted JSON lists (`criteria.ts`). */
export function storeRunCriteria(
  office: OfficeHandle,
  runId: string,
  criteria: { readonly known: string; readonly checked: string },
): void {
  office.run(
    `update runs set criteria_known = $known, criteria_checked = $checked
      where office_id = $office_id and run_id = $run`,
    { run: runId, known: criteria.known, checked: criteria.checked },
  );
}

/** The criteria the latest accepted report marks met, as a sorted JSON list (`criteria.ts`). */
export function storeReportedCriteria(office: OfficeHandle, runId: string, met: string): void {
  office.run(
    `update runs set criteria_reported = $met where office_id = $office_id and run_id = $run`,
    { run: runId, met },
  );
}

/**
 * The reviewer's turn, minute and token caps for a run that has none yet (0002); a cap the run
 * holds is never changed.
 */
export function storeReviewCaps(
  office: OfficeHandle,
  runId: string,
  caps: {
    readonly maxTurns: number | null;
    readonly maxMinutes: number | null;
    readonly budgetTokens: number | null;
  },
): void {
  office.run(
    `update runs set review_max_turns = coalesce(review_max_turns, $turns),
       review_max_minutes = coalesce(review_max_minutes, $minutes),
       review_max_tokens = coalesce(review_max_tokens, $tokens)
      where office_id = $office_id and run_id = $run`,
    { run: runId, turns: caps.maxTurns, minutes: caps.maxMinutes, tokens: caps.budgetTokens },
  );
}

/** The run's state as `lifecycle.ts` decides it; null for an unknown run. */
export function runState(office: OfficeHandle, runId: string): RunState | null {
  const row = office.get<{
    ended_at: number | null;
    end_kind: string | null;
    waiting: string | null;
    waiting_since: number | null;
    parked_ms: number;
  }>(
    `select ended_at, end_kind, waiting, waiting_since, parked_ms from runs
      where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null
    ? null
    : {
        endedAt: row.ended_at,
        ending: row.end_kind as RunEnd | null,
        waiting: row.waiting,
        waitingSince: row.waiting_since,
        parkedMs: row.parked_ms,
      };
}

/**
 * Inside the caller's transaction: `event` happens to the run `runId`. Its next state comes from
 * `nextRunState` and is written.
 * Returns the state before and after, or null when the event did not apply and nothing changed.
 */
export function applyRunEvent(
  office: OfficeHandle,
  runId: string,
  event: RunEvent,
): { readonly before: RunState; readonly after: RunState } | null {
  const before = runState(office, runId);
  if (before === null) return null;
  const after = nextRunState(before, event);
  if (after === null) return null;
  office.run(
    `update runs set ended_at = $ended_at, end_kind = $end_kind, waiting = $waiting,
       waiting_since = $waiting_since, parked_ms = $parked_ms
     where office_id = $office_id and run_id = $run`,
    {
      run: runId,
      ended_at: after.endedAt,
      end_kind: after.ending,
      waiting: after.waiting,
      waiting_since: after.waitingSince,
      parked_ms: after.parkedMs,
    },
  );
  return { before, after };
}

export function findRun(office: OfficeHandle, runId: RunId): StoredRun | null {
  const row = office.get<RunRow>(
    `select ${COLUMNS} from runs where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null ? null : toRecord(row);
}

/**
 * The office's active runs, oldest first: story runs that have not ended and whose claim is live,
 * and session runs that have not ended.
 */
export function activeRuns(office: OfficeHandle): StoredRun[] {
  return office
    .all<RunRow>(
      `select ${COLUMNS} from runs r
        where r.office_id = $office_id and r.ended_at is null
          and (r.kind = 'session' or exists (select 1 from claims c
                where c.office_id = r.office_id and c.run_id = r.run_id and c.released_at is null))
        order by r.started_at, r.run_id`,
    )
    .map(toRecord);
}

/** True when the office has an active run; `office.forget` refuses it with `office.busy`. */
export function hasActiveRun(office: OfficeHandle): boolean {
  return activeRuns(office).length > 0;
}

/**
 * The kinds of a run's steps: a phase entered, a verify loop or a review round started, and
 * (DIPO-142) a review round whose verdict was blocked, a pushed head whose required checks were
 * red, a conflict hand-off and a maintainer override past a blocked review, (DIPO-205) the cap
 * a done report's turn crossed, and (DIPO-299) a pushed head of a box run for which the host
 * reported no CI check at all (`ci-none`, valued with the head; not a CI attempt).
 */
export type RunStepKind =
  | "phase"
  | "loop"
  | "review"
  | "review-failed"
  | "ci"
  | "conflict"
  | "override"
  | "cap"
  | "ci-none";

/** Appends one step to the run's append-only history. */
export function appendRunStep(
  office: OfficeHandle,
  runId: RunId,
  kind: RunStepKind,
  value: string,
  at: number,
): void {
  office.run(
    `insert into run_steps (office_id, run_id, step, kind, value, at)
     values ($office_id, $run, (select coalesce(max(step), 0) + 1 from run_steps
       where office_id = $office_id and run_id = $run), $kind, $value, $at)`,
    { run: runId, kind, value, at },
  );
}

export interface StoredRunStep {
  readonly step: number;
  readonly kind: RunStepKind;
  readonly value: string;
  readonly at: number;
}

export function runSteps(office: OfficeHandle, runId: RunId): StoredRunStep[] {
  return office.all<StoredRunStep>(
    `select step, kind, value, at from run_steps where office_id = $office_id and run_id = $run
     order by step`,
    { run: runId },
  );
}

/** Keeps the effective configuration once per office and hash; a later sighting changes nothing. */
export function recordConfigSnapshot(
  office: OfficeHandle,
  hash: string,
  config: unknown,
  at: number,
): void {
  office.run(
    `insert or ignore into config_snapshots (office_id, config_hash, config, first_seen)
     values ($office_id, $hash, $config, $at)`,
    { hash, config: canonicalJson(config), at },
  );
}

/** The id of the office's current run profile, or null when it has none. */
export function currentProfileId(office: OfficeHandle): string | null {
  const row = office.get<{ profile_id: number }>(
    "select profile_id from run_profiles where office_id = $office_id and current = 1",
  );
  return row === null ? null : String(row.profile_id);
}

/** True when the run is open at In Review with no active period: in phase review, test or merge. */
export function openAtInReview(run: Pick<StoredRun, "endedAt" | "ending">): boolean {
  return run.endedAt !== null && run.ending === null;
}

/**
 * True when the parked run stood open at In Review when it parked at `parkedAt` (the park's first
 * time): a park keeps the end of an active period that ended before it, so a lift of the park
 * with no session returns the run to In Review (`unparkRun`).
 */
export function parkedFromInReview(
  run: Pick<StoredRun, "endedAt" | "ending">,
  parkedAt: number,
): boolean {
  return run.ending === "parked" && run.endedAt !== null && run.endedAt < parkedAt;
}

/**
 * SQL for the phase the newest `phase` step of the run aliased `r` names (0009), null when it has
 * none; `runPhase` in SQL.
 */
export const RUN_PHASE_SQL = `(select s.value from run_steps s where s.office_id = r.office_id
  and s.run_id = r.run_id and s.kind = 'phase' order by s.step desc limit 1)`;

/** The phase the run's newest `phase` step names (0009), or null when it has none. */
export function runPhase(office: OfficeHandle, runId: string): string | null {
  return (
    office.get<{ value: string }>(
      `select value from run_steps where office_id = $office_id and run_id = $run
        and kind = 'phase' order by step desc limit 1`,
      { run: runId },
    )?.value ?? null
  );
}

/**
 * When the run's caps start counting (0008 sections 6 and 9): its first worker host's start, else
 * the run's own, moved later by the time it stood parked (DIPO-75) or ended between its rounds and
 * in review (DIPO-142), so the time cap counts only the time its developer worked.
 */
export function capsStartedAt(
  run: StoredRun,
  firstHostStartedAt: number | null | undefined,
): number {
  return (firstHostStartedAt ?? run.startedAt) + (run.parkedMs ?? 0);
}

/**
 * Ends the run `runId` as `ending` (0020: done, parked or dropped), once: an open run ends, a
 * parked run ends again only as done or dropped, and a run done or dropped keeps its end
 * (`nextRunState`). Runs inside the caller's transaction. Retention removes a run's rows only once
 * it can no longer reopen (`records/retired.ts`).
 *
 * The one place a run ends (DIPO-49, 0007): the call that ends it also writes its `run_outcomes`
 * row, kept by retention (0007): tier, role, model, the outcome (its ending), the park reasons of its
 * parks, loops, review rounds, verify failures, budget tokens used, minutes worked, the story's
 * criteria count and the declared scope size. A park writes its `parks` row before it ends the
 * run, so its reason is counted. An end that closes the run's active period also makes the usage
 * of every agent whose exit was not ingested final (`finalizeRunAgents`, DIPO-51). It also writes
 * the run's `run.ended` entry on the office stream (0005, DIPO-397). True when this call ended the
 * run, false when the end did not apply.
 *
 * One end is not always the last (DIPO-75, DIPO-142): a parked run reopens on resume
 * (`reopenRun`), and its next end rewrites the provisional row with every park and round of the
 * run and the minutes it worked. Done is final (0019 section 13): a run open at In Review keeps
 * the end of its last active period, so its minutes count the time it worked, and its final row
 * is never rewritten.
 */
export function endRun(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  ending: RunEnd,
  reviewSince?: number,
): boolean {
  const ended = applyRunEvent(office, runId, {
    kind: "end",
    at,
    ending,
    ...(reviewSince === undefined ? {} : { reviewSince }),
  });
  if (ended === null) return false;
  // Usage of agents whose exit is not ingested yet reaches `usage_daily` now (0007 amendment of
  // 2026-10-14, DIPO-51); what ingestion adds later feeds only its change.
  if (ended.before.endedAt === null) finalizeRunAgents(office, runId, at);
  writeRunOutcome(office, runId, ending);
  appendRunEnded(office, runId, at, ended.after.endedAt ?? at, ending);
  return true;
}

/**
 * Appends the `run.ended` entry of the end `endRun` applied (0005 section 6), in the caller's
 * transaction. It names the run, and its story when the run has one; `endedAt` is the end of the
 * run's last active period, the time `runs.ended_at` keeps.
 */
function appendRunEnded(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  endedAt: number,
  ending: RunEnd,
): void {
  const run = findRun(office, runId);
  if (run === null) return;
  const key = run.key === null ? {} : { key: run.key };
  const story = run.story === null ? {} : { story: run.story };
  appendEntries(
    office,
    [
      {
        type: "run.ended",
        run: runId,
        ...key,
        delta: {
          run: runId,
          kind: run.kind,
          ending,
          endedAt: new Date(endedAt).toISOString(),
          ...key,
          ...story,
        },
      },
    ],
    { at },
  );
}

/**
 * Inside the caller's transaction: the parked run, or the run open at In Review, `runId` is active
 * again at `at`, and its provisional outcome row goes until its next end. False when the run is
 * active already, done or dropped.
 */
export function reopenRun(office: OfficeHandle, runId: RunId, at: number): boolean {
  if (applyRunEvent(office, runId, { kind: "reopen", at }) === null) return false;
  dropProvisionalOutcome(office, runId);
  return true;
}

/**
 * Inside the caller's transaction: the park of the parked run `runId` is lifted with no session
 * (the maintainer's override, or a resume that starts none): the run stands open at In Review
 * again, in the phase it parked in, and its provisional outcome row goes. False when it is not
 * parked.
 */
export function unparkRun(office: OfficeHandle, runId: RunId): boolean {
  if (applyRunEvent(office, runId, { kind: "unpark" }) === null) return false;
  dropProvisionalOutcome(office, runId);
  return true;
}

function dropProvisionalOutcome(office: OfficeHandle, runId: RunId): void {
  office.run(
    "delete from run_outcomes where office_id = $office_id and run_id = $run and final = 0",
    {
      run: runId,
    },
  );
}

/** How many steps of each counted kind the run has (`run_steps`). */
export interface RunRounds {
  readonly loops: number;
  readonly reviewRounds: number;
  readonly reviewRoundsFailed: number;
  readonly ciAttempts: number;
  readonly conflictHandoffs: number;
  readonly override: boolean;
}

/** The run's loops, review rounds, failed rounds, CI attempts, hand-offs and override. */
export function runRoundCounts(office: OfficeHandle, runId: string): RunRounds {
  const rows = office.all<{ kind: RunStepKind; n: number }>(
    `select kind, count(*) as n from run_steps where office_id = $office_id and run_id = $run
      group by kind`,
    { run: runId },
  );
  const n = (kind: RunStepKind): number => rows.find((row) => row.kind === kind)?.n ?? 0;
  // A conflict hand-off is its `start` step; its feedback, failure and resolution are steps too
  // (DIPO-149, `run/conflicts.ts`).
  const handOffs =
    n("conflict") === 0
      ? 0
      : (office.get<{ n: number }>(
          `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
            and kind = 'conflict' and value like 'start %'`,
          { run: runId },
        )?.n ?? 0);
  return {
    loops: n("loop"),
    reviewRounds: n("review"),
    reviewRoundsFailed: n("review-failed"),
    ciAttempts: n("ci"),
    conflictHandoffs: handOffs,
    override: n("override") > 0,
  };
}

/** The value of the `loop` step a red verify in the box writes (0002, DIPO-346). */
export const VERIFY_LOOP = "verify";

/**
 * Writes the run's `run_outcomes` row as of its end, replacing a provisional one; final for a
 * `done` end. A final row is never replaced.
 */
function writeRunOutcome(office: OfficeHandle, runId: RunId, ending: RunEnd): void {
  const run = findRun(office, runId);
  if (run === null || run.endedAt === null) return;
  const at = run.endedAt;
  const final = ending === "done";
  // History for retro (0007, 0020): the reasons the run's parks were made with (DIPO-360).
  const parks = office
    .all<{ reason: string }>(
      `select reason from parks where office_id = $office_id and run_id = $run order by park_id`,
      { run: runId },
    )
    .map((row) => row.reason);
  const rounds = runRoundCounts(office, runId);
  // The red verifies in the box at done (DIPO-346): each wrote a `VERIFY_LOOP` step.
  const failures =
    office.get<{ n: number }>(
      `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
        and kind = 'loop' and value = $value`,
      { run: runId, value: VERIFY_LOOP },
    )?.n ?? 0;
  // The developer's tokens only: a reviewer counts against its own caps, never the story's (0002).
  const budget = runTotals(office, runId, at, at).budgetTokens;
  // The run's web calls by tool, counted from its tool activity (0020 section 11b, DIPO-164).
  const web = office.get<{ searches: number; fetches: number }>(
    `select web_searches as searches, web_fetches as fetches from runs
      where office_id = $office_id and run_id = $run`,
    { run: runId },
  ) ?? { searches: 0, fetches: 0 };
  const criteria =
    run.key === null
      ? null
      : (office.get<{ total: number | null }>(
          `select criteria_total as total from backlog_mirror
            where office_id = $office_id and key = $key`,
          { key: run.key },
        )?.total ?? null);
  office.run(
    `insert into run_outcomes (office_id, run_id, story_id, tier, role, model, outcome,
       park_reasons, loops, review_rounds, verify_failures, budget_tokens, minutes,
       criteria_count, scope_size, ended_at, final, review_rounds_failed, ci_attempts,
       conflict_handoffs, override, web_searches, web_fetches)
     values ($office_id, $run, $story, $tier, $role, $model, $outcome, $parks, $loops, $reviews,
       $failures, $budget, $minutes, $criteria, $scope, $at, $final, $failed, $ci,
       $conflicts, $override, $searches, $fetches)
     on conflict (office_id, run_id) do update set story_id = excluded.story_id,
       tier = excluded.tier, role = excluded.role, model = excluded.model,
       outcome = excluded.outcome, park_reasons = excluded.park_reasons, loops = excluded.loops,
       review_rounds = excluded.review_rounds, verify_failures = excluded.verify_failures,
       budget_tokens = excluded.budget_tokens, minutes = excluded.minutes,
       criteria_count = excluded.criteria_count, scope_size = excluded.scope_size,
       ended_at = excluded.ended_at, final = excluded.final,
       review_rounds_failed = excluded.review_rounds_failed, ci_attempts = excluded.ci_attempts,
       conflict_handoffs = excluded.conflict_handoffs, override = excluded.override,
       web_searches = excluded.web_searches, web_fetches = excluded.web_fetches
     where run_outcomes.final = 0`,
    {
      run: runId,
      story: run.story,
      tier: run.tier,
      role: run.role,
      model: run.model,
      // How the run ended (0020); the reasons of its parks are kept next to it.
      outcome: ending,
      parks: JSON.stringify(parks),
      loops: rounds.loops,
      reviews: rounds.reviewRounds,
      failures,
      budget,
      minutes: Math.round(((at - run.startedAt - (run.parkedMs ?? 0)) / 60_000) * 100) / 100,
      criteria,
      scope: run.scope === null ? null : run.scope.length,
      at,
      final: final ? 1 : 0,
      failed: rounds.reviewRoundsFailed,
      ci: rounds.ciAttempts,
      conflicts: rounds.conflictHandoffs,
      override: rounds.override ? 1 : 0,
      searches: web.searches,
      fetches: web.fetches,
    },
  );
}

/** A run's `run_outcomes` row (DIPO-49, DIPO-142). */
export interface RunOutcome {
  readonly runId: string;
  readonly story: string | null;
  readonly tier: string | null;
  readonly role: string;
  readonly model: string;
  /** How the run ended: done, parked or dropped (0020). */
  readonly outcome: RunEnd;
  readonly parkReasons: readonly string[];
  readonly loops: number;
  readonly reviewRounds: number;
  readonly verifyFailures: number;
  readonly budgetTokens: number;
  readonly minutes: number;
  readonly criteriaCount: number | null;
  readonly scopeSize: number | null;
  readonly endedAt: number;
  /** True once Done wrote the final row. */
  readonly final: boolean;
  readonly reviewRoundsFailed: number;
  readonly ciAttempts: number;
  readonly conflictHandoffs: number;
  readonly override: boolean;
  /** The run's web searches and fetches (DIPO-164). */
  readonly webSearches: number;
  readonly webFetches: number;
}

export function runOutcome(office: OfficeHandle, runId: RunId): RunOutcome | null {
  const row = office.get<{
    run_id: string;
    story_id: string | null;
    tier: string | null;
    role: string;
    model: string;
    outcome: string;
    park_reasons: string;
    loops: number;
    review_rounds: number;
    verify_failures: number;
    budget_tokens: number;
    minutes: number;
    criteria_count: number | null;
    scope_size: number | null;
    ended_at: number;
    final: number;
    review_rounds_failed: number;
    ci_attempts: number;
    conflict_handoffs: number;
    override: number;
    web_searches: number;
    web_fetches: number;
  }>(`select * from run_outcomes where office_id = $office_id and run_id = $run`, { run: runId });
  return row === null
    ? null
    : {
        runId: row.run_id,
        story: row.story_id,
        tier: row.tier,
        role: row.role,
        model: row.model,
        outcome: row.outcome as RunEnd,
        parkReasons: JSON.parse(row.park_reasons) as string[],
        loops: row.loops,
        reviewRounds: row.review_rounds,
        verifyFailures: row.verify_failures,
        budgetTokens: row.budget_tokens,
        minutes: row.minutes,
        criteriaCount: row.criteria_count,
        scopeSize: row.scope_size,
        endedAt: row.ended_at,
        final: row.final === 1,
        reviewRoundsFailed: row.review_rounds_failed,
        ciAttempts: row.ci_attempts,
        conflictHandoffs: row.conflict_handoffs,
        override: row.override === 1,
        webSearches: row.web_searches,
        webFetches: row.web_fetches,
      };
}

/**
 * Retention (0007): deletes at most `limit` runs retired at `cutoff` (`retiredRun`), inside the
 * caller's transaction; returns how many it deleted. An active run, and one a park or a live claim
 * may reopen, is kept. Its outcome row is kept too.
 */
export function deleteRetiredRuns(office: OfficeHandle, cutoff: number, limit: number): number {
  return office.run(
    `delete from runs where rowid in (select rowid from runs
       where office_id = $office_id and ${retiredRun("runs")} limit $limit)`,
    { cutoff, limit },
  ).changes;
}
