// The work view (0005 sections 5 and 6, 0009 section 3): who works on a run, its phase, progress,
// usage with its budget share, the watchdog signals in effect and the health derived from them.
// Derived from facts (`runs`, `agents`, `run_steps`, `run_signals`, usage, stored output and the
// mirror's acceptance criteria, with the run's own criteria facts from its worker reports, DIPO-85)
// whenever it is needed, and written as the `view` of each work change-log entry; never stored as
// truth. A run reopened for a round shows its newest agent, a reviewer with its own role, and a
// run waiting for its place is not lost (DIPO-142).

import {
  AgentId,
  type Health,
  type Phase,
  type Progress,
  RoleId,
  RunId,
  StoryId,
  StoryKey,
  type WatchdogSignal,
  type WorkRef,
  type WorkView,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { readUsage } from "../ingest/usage";
import { runCaps } from "../run/caps";
import { runCriteriaMet } from "../run/criteria";
import { activeRuns, findRun, runRoundCounts, type StoredRun } from "../run/records";
import { activeSignals } from "../run/signals";

/** The phase a run is in before any phase step is recorded. */
const FIRST_PHASE: Phase = "setup";

/** The facts health is derived from (0009 section 3). */
export interface HealthFacts {
  /** The watchdog signals in effect. */
  readonly signals: readonly WatchdogSignal[];
  /** The worker exited and the engine has not processed the exit (the run has not ended). */
  readonly exitUnprocessed: boolean;
  /** An open question or a gate waiting on the maintainer for this run (none in M0). */
  readonly asking?: boolean;
  readonly loop: number;
  readonly loopCap: number;
}

/**
 * Health in the 0009 precedence: `lost`, `asking`, `looping`, `stuck`, `quiet`, `busy`. The
 * first rule that holds wins.
 */
export function deriveHealth(facts: HealthFacts): Health {
  const has = (signal: WatchdogSignal) => facts.signals.includes(signal);
  if (has("host-lost") || facts.exitUnprocessed) return "lost";
  if (facts.asking === true || has("input-wait")) return "asking";
  if (has("same-failure") || (facts.loopCap > 0 && facts.loop >= facts.loopCap)) return "looping";
  if (has("no-output")) return "stuck";
  if (has("quiet")) return "quiet";
  return "busy";
}

interface AgentRow {
  agent_id: string;
  role: string;
  model: string;
  ended_at: number | null;
}

/** The run's newest agent: the one working now, or the last one that did. */
function latestAgent(office: OfficeHandle, runId: string): AgentRow | null {
  return office.get<AgentRow>(
    `select agent_id, role, model, ended_at from agents
      where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: runId },
  );
}

function refOf(run: StoredRun, agent: AgentRow): WorkRef | null {
  if (run.kind !== "story" || run.key === null || run.story === null) return null;
  return {
    story: StoryId.parse(run.story),
    key: StoryKey.parse(run.key),
    run: RunId.parse(run.runId),
    agent: AgentId.parse(agent.agent_id),
    // The agent's own role: a reviewer of the run is no developer (0019 section 4).
    role: RoleId.parse(agent.role),
    tier: run.tier ?? "",
    model: agent.model,
  };
}

/** Who works on the story run `runId`; null for a session run or a run with no agent yet. */
export function workRefOf(office: OfficeHandle, runId: RunId): WorkRef | null {
  const run = findRun(office, runId);
  const agent = run === null ? null : latestAgent(office, runId);
  return run === null || agent === null ? null : refOf(run, agent);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function progressOf(office: OfficeHandle, run: StoredRun): Progress {
  const steps = office.all<{ kind: string; value: string }>(
    `select kind, value from run_steps where office_id = $office_id and run_id = $run
      and kind in ('loop', 'review') order by step`,
    { run: run.runId },
  );
  const criteria = office.get<{
    met: number | null;
    total: number | null;
    numbers: string | null;
  }>(
    `select criteria_met as met, criteria_total as total, criteria_numbers as numbers
      from backlog_mirror where office_id = $office_id and key = $key`,
    { key: run.key },
  );
  // The index shows the base branch (or the branch tip right after a claim) and lags the run
  // until the merge; the run's own facts count what its latest report marks met, among the
  // story's current criterion numbers (DIPO-85).
  const current =
    criteria === null || criteria.numbers === null
      ? null
      : (JSON.parse(criteria.numbers) as number[]);
  const own = runCriteriaMet(office, run.runId, current);
  const total = criteria?.total ?? own?.known ?? 0;
  const met = Math.max(criteria?.met ?? 0, own?.met ?? 0);
  // The review round cap with its grants and the failed rounds, once the run has a cap (0019).
  const reviewRoundCap = runCaps(office, run).reviewRoundCap;
  const review =
    reviewRoundCap === null
      ? {}
      : {
          reviewRoundCap,
          reviewRoundsFailed: runRoundCounts(office, run.runId).reviewRoundsFailed,
        };
  return {
    criteriaMet: total > 0 ? Math.min(met, total) : met,
    criteriaTotal: total,
    loop: steps.filter((step) => step.kind === "loop").length,
    loopCap: run.loopCap,
    // dipo stores no verify result of its own (DIPO-342): the box worker runs verify, CI checks.
    verify: "none",
    reviewRound: steps.filter((step) => step.kind === "review").length,
    ...review,
  };
}

/** The progress of the story run `runId` now, derived from its facts. */
export function runProgress(office: OfficeHandle, runId: RunId): Progress | null {
  const run = findRun(office, runId);
  return run === null ? null : progressOf(office, run);
}

function phaseOf(office: OfficeHandle, runId: string): Phase {
  return (
    office.get<{ value: string }>(
      `select value from run_steps where office_id = $office_id and run_id = $run
        and kind = 'phase' order by step desc limit 1`,
      { run: runId },
    )?.value ?? FIRST_PHASE
  );
}

function lastOutputAt(office: OfficeHandle, runId: string): number | null {
  return (
    office.get<{ at: number | null }>(
      `select max(at) as at from output_chunks where office_id = $office_id and run_id = $run
        and source = 'worker' and agent_id is not null`,
      { run: runId },
    )?.at ?? null
  );
}

function viewOf(office: OfficeHandle, run: StoredRun): WorkView | null {
  const agent = latestAgent(office, run.runId);
  if (agent === null) return null;
  const work = refOf(run, agent);
  if (work === null) return null;
  const progress = progressOf(office, run);
  const signals = activeSignals(office, run.runId);
  // A run reopened for a round waits for its place with the last session's agent ended
  // (DIPO-142): not lost.
  const waiting = run.waiting != null;
  const health = deriveHealth({
    signals: signals.map((signal) => signal.signal),
    exitUnprocessed: agent.ended_at !== null && run.endedAt === null && !waiting,
    loop: progress.loop,
    loopCap: progress.loopCap,
  });
  const output = lastOutputAt(office, run.runId);
  return {
    work,
    phase: phaseOf(office, run.runId),
    progress,
    usage: readUsage(office, {
      run: run.runId,
      agent: agent.agent_id,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: runCaps(office, run).budgetTokens,
    }),
    health,
    signals: signals.map((signal) => ({ signal: signal.signal, since: iso(signal.since) })),
    ...(output === null ? {} : { lastOutputAt: iso(output) }),
    startedAt: iso(run.startedAt),
  };
}

/** The view of the story run `runId` now; null for an unknown or session run, or one with no agent. */
export function workView(office: OfficeHandle, runId: RunId): WorkView | null {
  const run = findRun(office, runId);
  return run === null ? null : viewOf(office, run);
}

/** The views of the office's active story runs, oldest first. */
export function activeWorkViews(office: OfficeHandle): WorkView[] {
  return activeRuns(office).flatMap((run) => {
    const view = viewOf(office, run);
    return view === null ? [] : [view];
  });
}

/** Change-log types that carry the run's `WorkView` (contract minor 1, DIPO-52). */
export const WORK_VIEW_TYPES: ReadonlySet<string> = new Set([
  "work.assigned",
  "work.phase",
  "work.progress",
  "work.output",
  "work.observed",
  "usage.updated",
]);

/**
 * `entries` with the run's current `WorkView` as the `view` of each work entry that names a run
 * and has none yet. Call it inside the transaction that wrote the facts, just before appending,
 * so the view matches them. One view per run is derived for the whole batch.
 */
export function withWorkViews(office: OfficeHandle, entries: readonly NewEntry[]): NewEntry[] {
  const views = new Map<string, WorkView | null>();
  return entries.map((entry) => {
    if (entry.view !== undefined || entry.run === undefined || !WORK_VIEW_TYPES.has(entry.type)) {
      return entry;
    }
    let view = views.get(entry.run);
    if (view === undefined) {
      view = workView(office, entry.run);
      views.set(entry.run, view);
    }
    return view === null ? entry : { ...entry, view };
  });
}
