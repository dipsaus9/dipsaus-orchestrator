// Run facts (0007 section 4, DIPO-48): rows of `runs`, `run_steps` and `config_snapshots`, read and
// written through the office handle. Writers run inside the caller's `office.immediate`.
//
// A story run is active while it has not ended and its claim is live, so a claim released by
// teardown or a rollback never leaves an office busy; a session run is active until it ends.
//
// One story run spans every round of its claim (0019 section 13, DIPO-142): its active period ends
// at a park and at In Review, and `reopenRun` opens it again for a resume, a review, a fix round or
// a conflict hand-off, adding the time it stood ended to `parked_ms`. Each end rewrites its
// provisional `run_outcomes` row; Done writes the final one.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { canonicalJson } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import { finalizeRunAgents } from "../ingest/usage";

import type { BackstopSnapshot } from "./backstop";

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
  readonly worktree: string | null;
  readonly slot: number | null;
  readonly budgetUnit: string;
  readonly budgetLimit: number;
  readonly loopCap: number;
  /** The turn and minute caps at the start (DIPO-143); null for a run started before they were kept. */
  readonly maxTurns?: number | null;
  readonly maxMinutes?: number | null;
  readonly reviewRoundCap: number | null;
  /**
   * The review loop's other caps at the start (0019 sections 4 and 8, DIPO-146): red required
   * check heads (`mergeSlot.ciAttempts`), failed conflict hand-offs (`mergeSlot.conflictAttempts`),
   * the reviewer's own turn and minute caps (`review.maxTurns`, `review.maxMinutes`) and the
   * tokens added to the budget per review round started (`review.budgetTokens`). Null for a session
   * run and for a run started before they were kept.
   */
  readonly ciCap?: number | null;
  readonly conflictCap?: number | null;
  readonly reviewMaxTurns?: number | null;
  readonly reviewMaxMinutes?: number | null;
  readonly reviewAllowance?: number | null;
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
  readonly endedAt: number | null;
  readonly endKind: string | null;
  /**
   * Milliseconds the run stood parked before an answer reopened it (DIPO-75, migration 23), and
   * stood ended or in review between its rounds (DIPO-142); its caps and minutes count the time
   * its developer worked, not these. 0 when absent.
   */
  readonly parkedMs?: number;
  /**
   * What the reopened run waits for its place as (`places.ts`, DIPO-142), with the time it began
   * waiting; null when its session started or it waits for nothing.
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
  worktree: string | null;
  slot: number | null;
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
  review_allowance: number | null;
  config_hash: string;
  override_keys: string | null;
  run_profile_id: string | null;
  started_at: number;
  scope: string | null;
  gate_changes: string | null;
  ended_at: number | null;
  end_kind: string | null;
  parked_ms: number;
  waiting: string | null;
  waiting_since: number | null;
}

const COLUMNS = `run_id, kind, key, story_id, tier, role, model, start_sha, branch, worktree, slot,
  budget_unit, budget_limit, loop_cap, max_turns, max_minutes, review_round_cap, ci_cap,
  conflict_cap, review_max_turns, review_max_minutes, review_allowance, config_hash, override_keys,
  run_profile_id, started_at, scope, gate_changes, ended_at, end_kind, parked_ms, waiting,
  waiting_since`;

/** The columns a run row is inserted with: those a run starts with. */
const INSERTED = COLUMNS.replace(
  /, gate_changes, ended_at, end_kind, parked_ms, waiting,\s+waiting_since$/,
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
    worktree: row.worktree,
    slot: row.slot,
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
    reviewAllowance: row.review_allowance,
    configHash: row.config_hash,
    overrideKeys: row.override_keys === null ? null : (JSON.parse(row.override_keys) as string[]),
    runProfileId: row.run_profile_id,
    startedAt: row.started_at,
    scope: jsonList(row.scope),
    gateChanges: jsonList(row.gate_changes),
    endedAt: row.ended_at,
    endKind: row.end_kind,
    parkedMs: row.parked_ms,
    waiting: row.waiting,
    waitingSince: row.waiting_since,
  };
}

export function insertRun(office: OfficeHandle, run: NewRun): void {
  office.run(
    `insert into runs (office_id, ${INSERTED})
     values ($office_id, $run_id, $kind, $key, $story_id, $tier, $role, $model, $start_sha,
       $branch, $worktree, $slot, $budget_unit, $budget_limit, $loop_cap, $max_turns,
       $max_minutes, $review_round_cap, $ci_cap, $conflict_cap, $review_max_turns,
       $review_max_minutes, $review_allowance, $config_hash, $override_keys, $run_profile_id,
       $started_at, $scope)`,
    {
      run_id: run.runId,
      kind: run.kind,
      key: run.key,
      story_id: run.story,
      tier: run.tier,
      role: run.role,
      model: run.model,
      start_sha: run.startSha,
      branch: run.branch,
      worktree: run.worktree,
      slot: run.slot,
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
      review_allowance: run.reviewAllowance ?? null,
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

export function findRun(office: OfficeHandle, runId: RunId): StoredRun | null {
  const row = office.get<RunRow>(
    `select ${COLUMNS} from runs where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null ? null : toRecord(row);
}

/**
 * Stores the DIPO-49 backstop's run-start snapshot with the run (DIPO-93), so a run re-attached
 * after a restart keeps its backstop. Null clears it. Call it inside a write transaction.
 */
export function storeBackstopSnapshot(
  office: OfficeHandle,
  runId: string,
  snapshot: BackstopSnapshot | null,
): void {
  office.run(
    `update runs set backstop_snapshot = $snapshot
      where office_id = $office_id and run_id = $run`,
    { snapshot: snapshot === null ? null : JSON.stringify(snapshot), run: runId },
  );
}

/**
 * The run's stored backstop snapshot (DIPO-93); null when none was taken, or the run ended since
 * (`endRun` clears it: the engine's own commit at the end moves what it compares).
 */
export function backstopSnapshotOf(office: OfficeHandle, runId: string): BackstopSnapshot | null {
  const row = office.get<{ backstop_snapshot: string | null }>(
    "select backstop_snapshot from runs where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  if (row?.backstop_snapshot == null) return null;
  try {
    const value = JSON.parse(row.backstop_snapshot) as Partial<BackstopSnapshot>;
    return typeof value.head === "string" &&
      typeof value.branch === "string" &&
      typeof value.stash === "string" &&
      typeof value.backlogStatus === "string"
      ? {
          head: value.head,
          branch: value.branch,
          stash: value.stash,
          backlogStatus: value.backlogStatus,
        }
      : null;
  } catch {
    return null;
  }
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

/** The outcome of a run that ended at In Review (DIPO-49). */
export const IN_REVIEW_END = "in-review";

/** The end kind of a review period: the run waits for the verdict, CI or the merge gate. */
export const REVIEWED_END = "reviewed";

/**
 * The end kind of a run whose story is Done (0019 section 13): the release reason the Done poll's
 * teardown ends it with (`worktree/teardown.ts`).
 */
export const DONE_END = "done";

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

/** The `run_outcomes.outcome` of a run that parked its story. */
export const PARKED_OUTCOME = "parked";

/**
 * Ends the run `runId` with `kind` (for example the release reason of its claim), once: a run
 * that already ended keeps its end. Runs inside the caller's transaction. Retention removes a
 * run's rows only once it ended (`retention/run.ts`).
 *
 * The one place a run ends (DIPO-49, 0007 amendment of 2026-10-12): the call that ends it also
 * writes its `run_outcomes` row, kept until purge: tier, role, model, the outcome (`parked` when
 * the run parked its story, with the park reasons; else the end kind, such as `in-review` or
 * `start-failed`), loops, review rounds, verify failures, budget tokens used, minutes worked, the
 * story's criteria count and the declared scope size. A park writes its `parks` row before it
 * ends the run, so its reason is counted. It also makes the usage of every agent whose exit was
 * not ingested final (`finalizeRunAgents`, DIPO-51). True when this call ended the run, false
 * when it had ended before.
 *
 * One end is not always the last (DIPO-75, DIPO-142): a run is reopened for a resume, a review, a
 * fix round or a conflict hand-off (`reopenRun`), so each end rewrites the provisional row with
 * every park and round of the run and the minutes it worked. Done is the final end (0019 section
 * 13): a `done` end of a run whose last active period already ended (at In Review) sets its end
 * kind and writes the final row (`finishRun`); a final row is never rewritten.
 */
export function endRun(office: OfficeHandle, runId: RunId, at: number, kind: string): boolean {
  const ended = office.run(
    `update runs set ended_at = $at, end_kind = $kind, backstop_snapshot = null,
       waiting = null, waiting_since = null
     where office_id = $office_id and run_id = $run and ended_at is null`,
    { run: runId, at, kind },
  );
  if (ended.changes > 0) {
    // Usage of agents whose exit is not ingested yet reaches `usage_daily` now (0007 amendment of
    // 2026-10-14, DIPO-51); what ingestion adds later feeds only its change.
    finalizeRunAgents(office, runId, at);
    writeRunOutcome(office, runId, kind);
    return true;
  }
  if (kind === DONE_END) finishRun(office, runId);
  return false;
}

/**
 * Done (0019 section 13): the ended run `runId` takes the end kind `done` and its final
 * `run_outcomes` row is written, with its loops, review rounds and failed rounds, CI attempts,
 * conflict hand-offs and any override. Its end time stays the end of its last active period, so
 * its minutes count the time it worked. False when the run is open, unknown or final already.
 * Inside the caller's transaction.
 */
export function finishRun(office: OfficeHandle, runId: RunId): boolean {
  const run = findRun(office, runId);
  if (run === null || run.endedAt === null) return false;
  const final = office.get<{ final: number }>(
    "select final from run_outcomes where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  if (final?.final === 1) return false;
  office.run(`update runs set end_kind = $kind where office_id = $office_id and run_id = $run`, {
    run: runId,
    kind: DONE_END,
  });
  writeRunOutcome(office, runId, DONE_END);
  return true;
}

/**
 * Opens the ended story run `runId` again for a new active period (0019 section 13, DIPO-75): its
 * end is cleared and the time since it ended is added to `parked_ms`, so its caps and minutes
 * count only the time its developer worked; its provisional outcome row goes until its next end.
 * A run whose story is Done stays ended. True when this call reopened it. Inside the caller's
 * transaction.
 */
export function reopenRun(office: OfficeHandle, runId: RunId, at: number): boolean {
  const reopened = office.run(
    `update runs set parked_ms = parked_ms + max(0, $at - coalesce(ended_at, $at)),
       ended_at = null, end_kind = null
     where office_id = $office_id and run_id = $run and ended_at is not null
       and end_kind is not $done`,
    { run: runId, at, done: DONE_END },
  );
  if (reopened.changes === 0) return false;
  office.run(
    "delete from run_outcomes where office_id = $office_id and run_id = $run and final = 0",
    { run: runId },
  );
  return true;
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

/**
 * Writes the run's `run_outcomes` row as of its end, replacing a provisional one; final for a
 * `done` end. A final row is never replaced.
 */
function writeRunOutcome(office: OfficeHandle, runId: RunId, kind: string): void {
  const run = findRun(office, runId);
  if (run === null || run.endedAt === null) return;
  const at = run.endedAt;
  const final = kind === DONE_END;
  const parks = office
    .all<{ reason: string }>(
      `select reason from parks where office_id = $office_id and run_id = $run order by park_id`,
      { run: runId },
    )
    .map((row) => row.reason);
  const count = (sql: string): number => office.get<{ n: number }>(sql, { run: runId })?.n ?? 0;
  const rounds = runRoundCounts(office, runId);
  // dipo runs no verify of its own any more (DIPO-342): the column stays, always 0.
  const failures = 0;
  const budget = count(
    `select coalesce(sum(input + output + cache_create), 0) as n from usage_totals
      where office_id = $office_id and run_id = $run`,
  );
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
       criteria_count, scope_size, ended_at, end_kind, final, review_rounds_failed, ci_attempts,
       conflict_handoffs, override, web_searches, web_fetches)
     values ($office_id, $run, $story, $tier, $role, $model, $outcome, $parks, $loops, $reviews,
       $failures, $budget, $minutes, $criteria, $scope, $at, $kind, $final, $failed, $ci,
       $conflicts, $override, $searches, $fetches)
     on conflict (office_id, run_id) do update set story_id = excluded.story_id,
       tier = excluded.tier, role = excluded.role, model = excluded.model,
       outcome = excluded.outcome, park_reasons = excluded.park_reasons, loops = excluded.loops,
       review_rounds = excluded.review_rounds, verify_failures = excluded.verify_failures,
       budget_tokens = excluded.budget_tokens, minutes = excluded.minutes,
       criteria_count = excluded.criteria_count, scope_size = excluded.scope_size,
       ended_at = excluded.ended_at, end_kind = excluded.end_kind, final = excluded.final,
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
      // Done is the story's outcome, whatever parks the run had on the way.
      outcome: final ? DONE_END : parks.length > 0 ? PARKED_OUTCOME : kind,
      parks: JSON.stringify(parks),
      loops: rounds.loops,
      reviews: rounds.reviewRounds,
      failures,
      budget,
      minutes: Math.round(((at - run.startedAt - (run.parkedMs ?? 0)) / 60_000) * 100) / 100,
      criteria,
      scope: run.scope === null ? null : run.scope.length,
      at,
      kind,
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
  readonly outcome: string;
  readonly parkReasons: readonly string[];
  readonly loops: number;
  readonly reviewRounds: number;
  readonly verifyFailures: number;
  readonly budgetTokens: number;
  readonly minutes: number;
  readonly criteriaCount: number | null;
  readonly scopeSize: number | null;
  readonly endedAt: number;
  /** The end kind of the run's end that wrote the row; null on a row written before DIPO-142. */
  readonly endKind: string | null;
  /** True once Done wrote the final row. */
  readonly final: boolean;
  readonly reviewRoundsFailed: number;
  readonly ciAttempts: number;
  readonly conflictHandoffs: number;
  readonly override: boolean;
  /** The run's WebSearch and WebFetch calls (DIPO-164). */
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
    end_kind: string | null;
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
        outcome: row.outcome,
        parkReasons: JSON.parse(row.park_reasons) as string[],
        loops: row.loops,
        reviewRounds: row.review_rounds,
        verifyFailures: row.verify_failures,
        budgetTokens: row.budget_tokens,
        minutes: row.minutes,
        criteriaCount: row.criteria_count,
        scopeSize: row.scope_size,
        endedAt: row.ended_at,
        endKind: row.end_kind,
        final: row.final === 1,
        reviewRoundsFailed: row.review_rounds_failed,
        ciAttempts: row.ci_attempts,
        conflictHandoffs: row.conflict_handoffs,
        override: row.override === 1,
        webSearches: row.web_searches,
        webFetches: row.web_fetches,
      };
}
