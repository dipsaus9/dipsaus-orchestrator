// The engine caps of a run (0008, 0020): budget tokens (input + output + cache creation, summed
// over the run's developer agents), turns summed by the engine (the CLI's `--max-turns` counts
// again with every queued message, so it is only a backstop) and wall-clock minutes since the
// worker started, sleep included. A cap fires at 100%. Caps are fixed at run start and grow only
// by a recorded grant (`grants.ts`). The reviewer counts against caps of its own (0002).
//
// The caps see only the usage the adapter could read (DIPO-315). A run whose worker stream drifts
// (lines that fail their schema or have a message type the adapter drops, `STREAM_DRIFT_LINES` of
// them over the run's agents, or one turn end whose usage cannot be read) parks `worker-failed`
// as `worker-failed` instead of running past its budget unseen.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Caps } from "../workers/types";

import { grantTotals } from "./grants";
import type { StoredRun } from "./run-records";

/**
 * The ms the run's worker questions waited live up to `now` (0020 section 7, DIPO-159, the
 * `questions` table of `questions/questions.ts`): from each question's `asked_at` to the first of its
 * close, its park (the park's own time is the run's `parked_ms`), the end of its wait and `now`.
 * The minute cap leaves them out.
 */
export function questionWaitMs(office: OfficeHandle, runId: string, now: number): number {
  const row = office.get<{ total: number | null }>(
    `select sum(max(0, min(coalesce(q.closed_at, $now), coalesce(p.at, $now), q.wait_until, $now)
         - q.asked_at)) as total
       from questions q
       left join parks p on p.office_id = q.office_id and p.park_id = q.park_id
      where q.office_id = $office_id and q.run_id = $run and q.kind = 'question'
        and q.wait_until is not null`,
    { run: runId, now },
  );
  return row?.total ?? 0;
}

/** The cap that fired, as the park detail and the `cap` intent name it. */
export type CapName = "budgetTokens" | "maxTurns" | "maxMinutes";

/** What a run has used so far. */
export interface RunTotals {
  readonly budgetTokens: number;
  readonly turns: number;
  readonly elapsedMs: number;
}

export interface FiredCap {
  readonly cap: CapName;
  /** One line for the park detail, naming the cap, the limit and what was used. */
  readonly detail: string;
}

const MINUTE_MS = 60_000;

/**
 * The unreadable stream lines at which a run parks `worker-failed` (DIPO-315, a design
 * choice). A new message type the CLI sends with every turn, or a changed field of a frequent line,
 * reaches ten within a few turns, while one odd line (a line cut at a crash) never does. A turn end
 * whose usage cannot be read parks at once, whatever the count.
 */
export const STREAM_DRIFT_LINES = 10;

/** What a stream drift park says (DIPO-315). */
export interface StreamDriftFacts {
  /** `usage` when a turn end's usage cannot be read; else the count reached the threshold. */
  readonly usage: boolean;
  /** The worker and its version, as the adapter names them. */
  readonly worker: string;
  /** The deciding line's problem. */
  readonly detail: string;
  readonly lines: number;
  readonly threshold: number;
}

/** Pure: the park detail of a stream drift, naming the worker's version and the count. */
export function streamDriftDetail(facts: StreamDriftFacts): string {
  const counted = `${count(facts.lines)} unreadable stream ${facts.lines === 1 ? "line" : "lines"} in the run (the threshold is ${count(facts.threshold)})`;
  if (facts.usage) {
    return `stream drift on ${facts.worker}: ${facts.detail}, so the caps cannot count the turn's usage; ${counted}. A resume starts the count again from 0.`;
  }
  return `stream drift on ${facts.worker}: ${counted}, lines that failed their schema or had a message type dipo drops, so the caps may not see all usage; the last: ${facts.detail}. A resume starts the count again from 0.`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Pure: the first cap the totals reached, in the order tokens, turns, minutes; null when none. */
export function firedCap(caps: Caps, totals: RunTotals): FiredCap | null {
  if (totals.budgetTokens >= caps.budgetTokens) {
    return {
      cap: "budgetTokens",
      detail: `token budget reached: ${count(totals.budgetTokens)} of ${count(caps.budgetTokens)} budget tokens (input, output and cache creation)`,
    };
  }
  if (totals.turns >= caps.maxTurns) {
    return {
      cap: "maxTurns",
      detail: `turn cap reached: ${count(totals.turns)} of ${count(caps.maxTurns)} turns`,
    };
  }
  if (totals.elapsedMs >= caps.maxMinutes * MINUTE_MS) {
    return {
      cap: "maxMinutes",
      detail: `time cap reached: ${count(Math.floor(totals.elapsedMs / MINUTE_MS))} of ${count(caps.maxMinutes)} minutes since the worker started`,
    };
  }
  return null;
}

/** The role of a run's reviewer agents (0002); its usage counts against its own caps only. */
export const REVIEWER_ROLE = "reviewer";

/**
 * The developer's totals of the run from the stored usage, and the wall-clock time from
 * `startedAt` (when its worker host started, moved by the time it stood parked, ended or in
 * review) to `now`, less the time its worker questions waited live (0020). The budget and the
 * turns count only the developer's agents: a reviewer's tokens, turns and minutes count against
 * the reviewer's own caps and never against the story's (0002).
 */
export function runTotals(
  office: OfficeHandle,
  runId: RunId,
  startedAt: number,
  now: number,
): RunTotals {
  const row = office.get<{ budget: number; turns: number }>(
    `select coalesce(sum(t.input + t.output + t.cache_create), 0) as budget,
       coalesce(sum(t.turns), 0) as turns
     from usage_totals t
     left join agents a on a.office_id = t.office_id and a.agent_id = t.agent_id
     where t.office_id = $office_id and t.run_id = $run
       and coalesce(a.role, t.role) is not $reviewer`,
    { run: runId, reviewer: REVIEWER_ROLE },
  );
  return {
    budgetTokens: row?.budget ?? 0,
    turns: row?.turns ?? 0,
    // The live wait of its worker questions (0020, DIPO-159) does not count.
    elapsedMs: Math.max(0, now - startedAt - questionWaitMs(office, runId, now)),
  };
}

/**
 * What one reviewer session has used (0002): the tokens and turns of the reviewer agent `agent`
 * alone, and the wall-clock time since its session started. They count against the reviewer's own
 * caps, never against the story's budget.
 */
export function reviewTotals(
  office: OfficeHandle,
  runId: RunId,
  agent: string,
  startedAt: number,
  now: number,
): RunTotals {
  const row = office.get<{ budget: number; turns: number }>(
    `select coalesce(sum(input + output + cache_create), 0) as budget,
       coalesce(sum(turns), 0) as turns
     from usage_totals where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { run: runId, agent },
  );
  return {
    budgetTokens: row?.budget ?? 0,
    turns: row?.turns ?? 0,
    elapsedMs: Math.max(0, now - startedAt),
  };
}

/**
 * The caps a run counts against: the developer's `Caps` the workers get, one counted cap per
 * feedback source (0002: loops for the report gate and verify, CI attempts, failed review rounds,
 * failed conflict hand-offs), and the reviewer's own caps per session. A cap the run has none of
 * is null: a session run, or a run started before it was kept (DIPO-146).
 */
export interface RunCaps extends Caps {
  readonly loopCap: number;
  readonly reviewRoundCap: number | null;
  readonly ciCap: number | null;
  readonly conflictCap: number | null;
  /** The reviewer's own caps per session (0002); never the developer's, never grown by a grant. */
  readonly reviewMaxTurns: number | null;
  readonly reviewMaxMinutes: number | null;
  readonly reviewMaxTokens: number | null;
}

/** A snapshot cap plus its grants; a cap the run has none of stays null. */
function granted(cap: number | null | undefined, grant: number): number | null {
  return cap == null ? null : cap + grant;
}

/**
 * The caps of a run now (0020): its start snapshot plus its grants, and nothing else. A `budget`
 * grant raises tokens, turns and minutes; a `round` grant the counted cap it names. The tier of
 * the office is never read for a snapshot, so an edit of the tier reaches new runs only. `legacy`
 * supplies turns and minutes for a run started before they were kept; without it those are
 * unbounded.
 */
export function runCaps(
  office: OfficeHandle,
  run: StoredRun,
  legacy?: Pick<Caps, "maxTurns" | "maxMinutes">,
): RunCaps {
  const grants = grantTotals(office, run.runId);
  return {
    budgetTokens: run.budgetLimit + grants.budget.tokens,
    maxTurns: (run.maxTurns ?? legacy?.maxTurns ?? Number.POSITIVE_INFINITY) + grants.budget.turns,
    maxMinutes:
      (run.maxMinutes ?? legacy?.maxMinutes ?? Number.POSITIVE_INFINITY) + grants.budget.minutes,
    loopCap: run.loopCap + grants.rounds.loops,
    reviewRoundCap: granted(run.reviewRoundCap, grants.rounds.reviewRounds),
    ciCap: granted(run.ciCap, grants.rounds.ciAttempts),
    conflictCap: granted(run.conflictCap, grants.rounds.conflictAttempts),
    reviewMaxTurns: run.reviewMaxTurns ?? null,
    reviewMaxMinutes: run.reviewMaxMinutes ?? null,
    reviewMaxTokens: run.reviewMaxTokens ?? null,
  };
}
