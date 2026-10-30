// The exits a restart left undecided (DIPO-51 maintainer decision Q6, split out of `outcomes.ts`
// by DIPO-128): the load step that decides them once an office is loaded.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { workRefOf } from "../views/work";

import type { RunEnding } from "./control-types";
import { runIntents } from "./intents";
import type { ExitOutcomes } from "./outcome-exits";
import type { SessionStarts } from "./outcome-sessions";
import type { OutcomeSupport } from "./outcome-support";
import {
  HOST_LOST_END,
  intentTag,
  messageOf,
  REDISPATCH_STEP,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import { activeRuns, capsStartedAt, type StoredRun } from "./records";
import { activeSignals, clearSignals } from "./signals";

/**
 * The intent detail tag of a maintainer pause, which `work.pause` stored before `story.park`
 * replaced it (DIPO-344). No code writes it any more; a run still paused by one is parked at load.
 */
export const LEGACY_PAUSE_TAG = "maintainer-pause";

/** The detail of the park of a run that was paused when dipo was upgraded. */
export const LEGACY_PAUSE_DETAIL =
  "Paused by the maintainer before dipo replaced pausing with parking; resume it to continue";

/**
 * The intent detail tag of a plan-limit hold, which a rejected plan limit stored before the
 * office's starts paused replaced the hold (DIPO-359). No code writes it any more; a run still held
 * by one, or by its `plan-limit` signal, is parked at load.
 */
export const LEGACY_PLAN_LIMIT_TAG = "plan-limit";

/** The detail of the park of a run that a plan limit held when dipo was upgraded. */
export const LEGACY_PLAN_LIMIT_DETAIL =
  "plan limit (held before dipo paused the office's starts instead)";

export class Redispatch {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeSupport["guard"];
  readonly #exits: ExitOutcomes;
  readonly #sessions: SessionStarts;

  constructor(support: OutcomeSupport, exits: ExitOutcomes, sessions: SessionStarts) {
    this.#s = support;
    this.#deps = support.deps;
    this.#guard = support.guard;
    this.#exits = exits;
    this.#sessions = sessions;
  }

  // ---- after a restart (maintainer decision Q6) ------------------------------------------------

  /**
   * The load step: once the office is loaded, the exits a restart left undecided are decided.
   * It runs after the load on the clock, so the office can be reached by id.
   */
  get feature(): FeatureModule {
    return {
      name: "run-outcomes",
      register: (registry) => {
        registry.registerLoadStep(REDISPATCH_STEP, (ctx) => {
          ctx.clock.setTimeout(() => {
            this.redispatch(ctx.officeId).catch((error: unknown) => {
              this.#deps.warn?.("deciding exits after a restart failed", {
                office: ctx.officeId,
                reason: messageOf(error),
              });
            });
          }, 0);
          return { ok: true };
        });
      },
    };
  }

  /**
   * Runs paused or held before the upgrade: with no pause or hold left, such a run would stay
   * active with no session, holding its worker place. A maintainer's pause (an unresolved
   * `maintainer-pause` intent, DIPO-344) parks `by-maintainer`, so `work.resume` continues it. A
   * plan-limit hold (an unresolved `plan-limit` pause intent, or the run's `plan-limit` signal,
   * DIPO-359) parks `worker-failed` to resume by itself once the office's starts are not paused,
   * its signal cleared. Each pause is resolved `run-ended` and a live worker is stopped first.
   * Returns how many runs it parked.
   */
  async #parkPaused(office: OfficeHandle): Promise<number> {
    let parked = 0;
    for (const run of activeRuns(office)) {
      if (run.kind !== "story" || this.#guard.busy(run.runId)) continue;
      const pauses = runIntents(office, run.runId).filter(
        (intent) => intent.resolvedAt === null && intent.kind === "pause",
      );
      const byMaintainer = pauses.some((pause) => pause.detail.startsWith(LEGACY_PAUSE_TAG));
      const held =
        !byMaintainer &&
        (pauses.some((pause) => intentTag(pause.detail) === LEGACY_PLAN_LIMIT_TAG) ||
          activeSignals(office, run.runId).some((signal) => signal.signal === "plan-limit"));
      if (!byMaintainer && !held) continue;
      const at = this.#deps.clock.now();
      for (const pause of pauses) this.#s.resolve(office, run.runId, pause, "run-ended", at);
      if (held) office.immediate(() => clearSignals(office, run.runId, ["plan-limit"], at));
      parked += 1;
      const ending: Omit<RunEnding, "intent" | "ops"> = byMaintainer
        ? { reason: "by-maintainer", detail: LEGACY_PAUSE_DETAIL }
        : {
            reason: "worker-failed",
            detail: LEGACY_PLAN_LIMIT_DETAIL,
            resumeOnLift: true,
          };
      await this.#guard.within(`${run.runId} legacy-pause`, () =>
        this.#parkRun(office, run, ending),
      );
    }
    return parked;
  }

  async #parkRun(
    office: OfficeHandle,
    run: StoredRun,
    ending: Omit<RunEnding, "intent" | "ops">,
  ): Promise<void> {
    const ender = this.#deps.ender();
    // A worker re-attached after the restart still runs: run control stops it, then parks.
    if (ender.live(run.runId)) {
      ender.begin(run.runId, {
        ...ending,
        intent: "stop",
        ops: this.#deps.encode({ kind: "stop" }),
      });
      return;
    }
    const work = workRefOf(office, run.runId) ?? undefined;
    await ender.park(office, run, work, { ...ending, intent: "park", ops: [] });
  }

  /**
   * Decides the exits that were ingested but not decided before the daemon stopped: every active
   * story run whose newest agent ended with no recorded decision (`end_reason` still `exited`),
   * and no other session after it. A newest agent that ended `crashed` or
   * `prompt-too-long` had its decision recorded but its next session never started: that session
   * starts now (a resume after a crash, a handoff after a full context).
   */
  async redispatch(officeId: OfficeId): Promise<number> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return 0;
    // Park resumes a restart interrupted (DIPO-75) first: their runs are skipped below.
    let count = (await this.#deps.recoverParks?.(officeId, office)) ?? 0;
    count += await this.#parkPaused(office);
    for (const run of activeRuns(office)) {
      // A run decided here, or followed by run control (re-attached, DIPO-57), is decided there.
      const tracked = this.#deps.ender().isTracked?.(run.runId) ?? false;
      if (run.kind !== "story" || this.#guard.busy(run.runId) || tracked) continue;
      // A run reopened and waiting for its place has no exit to decide (DIPO-142).
      if (run.waiting != null) continue;
      const agent = office.get<{
        agent_id: string;
        end_reason: string | null;
        ended_at: number | null;
      }>(
        `select agent_id, end_reason, ended_at from agents
          where office_id = $office_id and run_id = $run
          order by started_at desc, rowid desc limit 1`,
        { run: run.runId },
      );
      if (agent === null || agent.ended_at === null) continue;
      // A host newer than the newest agent is a session that started while the daemon stopped
      // (DIPO-57): re-attach follows it; no other session may start next to it.
      const newestHost = office.get<{ agent_id: string }>(
        `select agent_id from worker_hosts where office_id = $office_id and run_id = $run
          order by started_at desc, rowid desc limit 1`,
        { run: run.runId },
      );
      if (newestHost !== null && newestHost.agent_id !== agent.agent_id) continue;
      // A crash, a full context or a lost host decided before the stop, whose next session never
      // started.
      const decided =
        agent.end_reason === "crashed" ||
        agent.end_reason === "prompt-too-long" ||
        agent.end_reason === HOST_LOST_END
          ? agent.end_reason
          : null;
      if (agent.end_reason !== "exited" && decided === null) continue;
      const cursor = office.get<{ parse_state: string }>(
        `select parse_state from ingest_cursors
          where office_id = $office_id and run_id = $run and agent_id = $agent and source_kind = 'host-events'`,
        { run: run.runId, agent: agent.agent_id },
      );
      const host = office.get<{
        exit_code: number | null;
        exit_signal: string | null;
        started_at: number;
      }>(
        `select exit_code, exit_signal,
           (select min(started_at) from worker_hosts h2
             where h2.office_id = h.office_id and h2.run_id = h.run_id) as started_at
          from worker_hosts h where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: run.runId, agent: agent.agent_id },
      );
      const work = workRefOf(office, run.runId);
      const caps = this.#deps.caps?.(officeId, run) ?? null;
      if (cursor === null || work === null || caps === null) continue;
      count += 1;
      const view: RunView = {
        office: officeId,
        runId: run.runId,
        work,
        caps,
        startedAt: capsStartedAt(run, host?.started_at),
      };
      if (decided !== null) {
        const key = `${run.runId} ${agent.agent_id}`;
        await this.#guard.within(key, async () => {
          if (decided === HOST_LOST_END) {
            await this.#exits.hostLost(office, run, view);
            return;
          }
          await this.#sessions.next(
            office,
            run,
            view,
            decided === "crashed"
              ? { mode: "resume", why: "a crash decided before the daemon restarted" }
              : {
                  mode: "handoff",
                  why: "a full context (prompt_too_long) decided before the daemon restarted",
                },
          );
        });
        continue;
      }
      await this.#exits.onExit({
        view,
        agent: agent.agent_id,
        turns: Promise.resolve(),
        ending: null,
        end: {
          exit: { code: host?.exit_code ?? null, signal: host?.exit_signal ?? null },
          state: JSON.parse(cursor.parse_state) as Readonly<Record<string, unknown>>,
        },
      });
    }
    return count;
  }
}
