// The exits a restart left undecided (DIPO-51 maintainer decision Q6, split out of `outcomes.ts`
// by DIPO-128): the load step that decides them once an office is loaded.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { workRefOf } from "../views/work";

import type { ExitOutcomes } from "./outcome-exits";
import type { SessionStarts } from "./outcome-sessions";
import type { OutcomeSupport } from "./outcome-support";
import {
  HOST_LOST_END,
  messageOf,
  openWait,
  REDISPATCH_STEP,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import { activeRuns, backstopSnapshotOf, capsStartedAt } from "./records";

export class Redispatch {
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeSupport["guard"];
  readonly #exits: ExitOutcomes;
  readonly #sessions: SessionStarts;

  constructor(support: OutcomeSupport, exits: ExitOutcomes, sessions: SessionStarts) {
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
   * Decides the exits that were ingested but not decided before the daemon stopped: every active
   * story run whose newest agent ended with no recorded decision (`end_reason` still `exited`),
   * no open wait and no other session after it. A newest agent that ended `crashed` or
   * `prompt-too-long` had its decision recorded but its next session never started: that session
   * starts now (a resume after a crash, a handoff after a full context).
   */
  async redispatch(officeId: OfficeId): Promise<number> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return 0;
    // Park resumes a restart interrupted (DIPO-75) first: their runs are skipped below.
    let count = (await this.#deps.recoverParks?.(officeId, office)) ?? 0;
    for (const run of activeRuns(office)) {
      // A run decided here, or followed by run control (re-attached, DIPO-57), is decided there.
      const tracked = this.#deps.ender().isTracked?.(run.runId) ?? false;
      if (run.kind !== "story" || this.#guard.busy(run.runId) || tracked) continue;
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
      if (openWait(office, run.runId) !== null) continue;
      const cursor = office.get<{ parse_state: string }>(
        `select parse_state from ingest_cursors
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
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
        // The run-start snapshot, stored with the run, keeps the backstop on (DIPO-93).
        snapshot: backstopSnapshotOf(office, run.runId),
      };
      if (decided !== null) {
        const key = `${run.runId} ${agent.agent_id}`;
        await this.#guard.within(key, async () => {
          if (decided === HOST_LOST_END) {
            await this.#exits.hostLost(office, run, view, agent.agent_id);
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
