// Run facts (0007 section 4, DIPO-48): rows of `runs`, `run_steps` and `config_snapshots`, read and
// written through the office handle. Writers run inside the caller's `office.immediate`.
//
// A story run is active while it has not ended and its claim is live, so a claim released by
// teardown or a rollback never leaves an office busy; a session run is active until it ends.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { canonicalJson } from "../config/merge";
import type { OfficeHandle } from "../db/office";

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
}

export interface StoredRun extends NewRun {
  readonly endedAt: number | null;
  readonly endKind: string | null;
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
  ended_at: number | null;
  end_kind: string | null;
}

const COLUMNS = `run_id, kind, key, story_id, tier, role, model, start_sha, branch, worktree, slot,
  budget_unit, budget_limit, loop_cap, review_round_cap, config_hash, override_keys,
  run_profile_id, started_at, ended_at, end_kind`;

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
    endedAt: row.ended_at,
    endKind: row.end_kind,
  };
}

export function insertRun(office: OfficeHandle, run: NewRun): void {
  office.run(
    `insert into runs (office_id, ${COLUMNS.replace(", ended_at, end_kind", "")})
     values ($office_id, $run_id, $kind, $key, $story_id, $tier, $role, $model, $start_sha,
       $branch, $worktree, $slot, $budget_unit, $budget_limit, $loop_cap, $review_round_cap,
       $config_hash, $override_keys, $run_profile_id, $started_at)`,
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
    },
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
