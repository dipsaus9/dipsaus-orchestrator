// Run facts (0007 section 4, DIPO-48): rows of `runs`, `run_steps` and `config_snapshots`, read and
// written through the office handle. Writers run inside the caller's `office.immediate`.
//
// A story run is active while it has not ended and its claim is live, so a claim released by
// teardown or a rollback never leaves an office busy; a session run is active until it ends.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { canonicalJson } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import { finalizeRunAgents } from "../ingest/usage";

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
  readonly reviewRoundCap: number | null;
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
   * Milliseconds the run stood parked before an answer reopened it (DIPO-75, migration 23); its
   * caps and minutes count the time it worked, not these. 0 when absent.
   */
  readonly parkedMs?: number;
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
  review_round_cap: number | null;
  config_hash: string;
  override_keys: string | null;
  run_profile_id: string | null;
  started_at: number;
  scope: string | null;
  gate_changes: string | null;
  ended_at: number | null;
  end_kind: string | null;
  parked_ms: number;
}

const COLUMNS = `run_id, kind, key, story_id, tier, role, model, start_sha, branch, worktree, slot,
  budget_unit, budget_limit, loop_cap, review_round_cap, config_hash, override_keys,
  run_profile_id, started_at, scope, gate_changes, ended_at, end_kind, parked_ms`;

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
    reviewRoundCap: row.review_round_cap,
    configHash: row.config_hash,
    overrideKeys: row.override_keys === null ? null : (JSON.parse(row.override_keys) as string[]),
    runProfileId: row.run_profile_id,
    startedAt: row.started_at,
    scope: jsonList(row.scope),
    gateChanges: jsonList(row.gate_changes),
    endedAt: row.ended_at,
    endKind: row.end_kind,
    parkedMs: row.parked_ms,
  };
}

export function insertRun(office: OfficeHandle, run: NewRun): void {
  office.run(
    `insert into runs (office_id, ${COLUMNS.replace(", gate_changes, ended_at, end_kind, parked_ms", "")})
     values ($office_id, $run_id, $kind, $key, $story_id, $tier, $role, $model, $start_sha,
       $branch, $worktree, $slot, $budget_unit, $budget_limit, $loop_cap, $review_round_cap,
       $config_hash, $override_keys, $run_profile_id, $started_at, $scope)`,
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
      review_round_cap: run.reviewRoundCap,
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

export type RunStepKind = "phase" | "loop" | "review";

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

/**
 * When the run's caps start counting (0008 sections 6 and 9): its first worker host's start, else
 * the run's own, moved later by the time it stood parked (DIPO-75), so the time cap counts only
 * the time it worked.
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
 * `start-failed`), loops, review rounds, verify failures, budget tokens used, minutes from start
 * to end, the story's criteria count and the declared scope size. A park writes its `parks` row
 * before it ends the run, so its reason is counted. It also makes the usage of every agent whose
 * exit was not ingested final (`finalizeRunAgents`, DIPO-51).
 *
 * One end is not always the last (DIPO-75): a run parked `needs-permission` is reopened when the
 * maintainer answers the park's question (`reopenParkedRun`): `ended_at` is cleared, the
 * `run_outcomes` row removed and the parked time added to `parked_ms`, so the next end writes the
 * row again with every park of the run and the minutes it worked. This awaits an ADR 0007
 * amendment the maintainer is asked about.
 */
export function endRun(office: OfficeHandle, runId: RunId, at: number, kind: string): void {
  const ended = office.run(
    `update runs set ended_at = $at, end_kind = $kind
     where office_id = $office_id and run_id = $run and ended_at is null`,
    { run: runId, at, kind },
  );
  if (ended.changes > 0) {
    // Usage of agents whose exit is not ingested yet reaches `usage_daily` now (0007 amendment of
    // 2026-10-14, DIPO-51); what ingestion adds later feeds only its change.
    finalizeRunAgents(office, runId, at);
    writeRunOutcome(office, runId, at, kind);
  }
}

function writeRunOutcome(office: OfficeHandle, runId: RunId, at: number, kind: string): void {
  const run = findRun(office, runId);
  if (run === null) return;
  const parks = office
    .all<{ reason: string }>(
      `select reason from parks where office_id = $office_id and run_id = $run order by park_id`,
      { run: runId },
    )
    .map((row) => row.reason);
  const count = (sql: string): number => office.get<{ n: number }>(sql, { run: runId })?.n ?? 0;
  const loops = count(
    `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
      and kind = 'loop'`,
  );
  const reviews = count(
    `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
      and kind = 'review'`,
  );
  const failures = count(
    `select count(*) as n from verify_results where office_id = $office_id and run_id = $run
      and passed = 0`,
  );
  const budget = count(
    `select coalesce(sum(input + output + cache_create), 0) as n from usage_totals
      where office_id = $office_id and run_id = $run`,
  );
  const criteria =
    run.key === null
      ? null
      : (office.get<{ total: number | null }>(
          `select criteria_total as total from backlog_mirror
            where office_id = $office_id and key = $key`,
          { key: run.key },
        )?.total ?? null);
  office.run(
    `insert or ignore into run_outcomes (office_id, run_id, story_id, tier, role, model, outcome,
       park_reasons, loops, review_rounds, verify_failures, budget_tokens, minutes,
       criteria_count, scope_size, ended_at)
     values ($office_id, $run, $story, $tier, $role, $model, $outcome, $parks, $loops, $reviews,
       $failures, $budget, $minutes, $criteria, $scope, $at)`,
    {
      run: runId,
      story: run.story,
      tier: run.tier,
      role: run.role,
      model: run.model,
      outcome: parks.length > 0 ? PARKED_OUTCOME : kind,
      parks: JSON.stringify(parks),
      loops,
      reviews,
      failures,
      budget,
      minutes: Math.round(((at - run.startedAt - (run.parkedMs ?? 0)) / 60_000) * 100) / 100,
      criteria,
      scope: run.scope === null ? null : run.scope.length,
      at,
    },
  );
}

/** A run's `run_outcomes` row (DIPO-49). */
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
      };
}
