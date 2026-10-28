// The facts and writes the worker outcome units share (DIPO-51, split out of `outcomes.ts` by
// DIPO-128): which intent explains an exit, what an agent ended as, the crash retry check, the
// park of an exited worker and the change-log write.

import type { OfficeId, RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { withWorkViews, workRefOf } from "../views/work";

import { firedCap, runTotals } from "./caps";
import type { RunEnding } from "./control-types";
import { DecidingGuard } from "./deciding";
import { type IntentKind, resolveIntent, runIntents, type StoredIntent } from "./intents";
import {
  HOST_LOST_END,
  intentTag,
  INTENT_TAGS,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import type { ParkOutcome } from "./park";
import { backstopSnapshotOf, capsStartedAt, type StoredRun } from "./records";

/** Kinds of intent that explain a worker's exit. */
const EXPLAINING: readonly IntentKind[] = ["stop", "cap", "park", "reassign", "pause"];

/** The outcome an untagged explaining intent gives the exit (0008 section 7). */
const UNTAGGED_OUTCOMES: Readonly<Partial<Record<IntentKind, string>>> = {
  stop: "stopped",
  cap: "capped",
  park: "blocked",
  reassign: "reassigned",
  pause: "paused",
};

export class OutcomeSupport {
  readonly deps: RunOutcomesDeps;
  /** The exits and resumes being decided now, as run and agent; a restart step leaves their runs alone. */
  readonly guard = new DecidingGuard();

  constructor(deps: RunOutcomesDeps) {
    this.deps = deps;
  }

  /** The view of an active run that is not tracked, as after a restart; null without one. */
  viewOf(officeId: OfficeId, office: OfficeHandle, run: StoredRun): RunView | null {
    const work = workRefOf(office, run.runId);
    const caps = this.deps.caps?.(officeId, run) ?? null;
    if (work === null || caps === null) return null;
    const host = office.get<{ started_at: number | null }>(
      `select min(started_at) as started_at from worker_hosts
        where office_id = $office_id and run_id = $run`,
      { run: run.runId },
    );
    return {
      office: officeId,
      runId: run.runId,
      work,
      caps,
      startedAt: capsStartedAt(run, host?.started_at),
      snapshot: backstopSnapshotOf(office, run.runId),
    };
  }

  /**
   * Parks a run whose worker already exited: the intent the park stores explains that exit, so
   * it is resolved at once.
   */
  async park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef,
    ending: RunEnding,
  ): Promise<ParkOutcome> {
    const parked = await this.deps.ender().park(office, run, work, ending);
    const intent = this.explaining(office, run.runId);
    if (intent !== null) {
      this.resolve(office, run.runId, intent, this.outcomeOf(intent), this.deps.clock.now());
    }
    return parked;
  }

  /** Why a crash gets no retry, as a detail suffix; null when it gets one. */
  noRetry(office: OfficeHandle, view: RunView, agent: string): string | null {
    if (this.deps.resumer === undefined) return "";
    if (
      this.endedAs(office, view.runId, agent, "crashed") ||
      this.endedAs(office, view.runId, agent, HOST_LOST_END)
    ) {
      return "; the run's one resume after a crash was used";
    }
    const cap = firedCap(
      view.caps,
      runTotals(office, view.runId, view.startedAt, this.deps.clock.now()),
    );
    if (cap !== null) return `; no budget remains (${cap.detail})`;
    return null;
  }

  // ---- facts -----------------------------------------------------------------------------------

  /** The newest unresolved intent that explains a worker's exit. */
  explaining(office: OfficeHandle, runId: RunId): StoredIntent | null {
    return (
      runIntents(office, runId)
        .filter((intent) => intent.resolvedAt === null && EXPLAINING.includes(intent.kind))
        .at(-1) ?? null
    );
  }

  outcomeOf(intent: StoredIntent): string {
    if (intent.kind === "stop" && intentTag(intent.detail) === INTENT_TAGS.initRejected) {
      return "initRejected";
    }
    return UNTAGGED_OUTCOMES[intent.kind] ?? intent.kind;
  }

  resolve(
    office: OfficeHandle,
    runId: RunId,
    intent: StoredIntent,
    outcome: string,
    at: number,
  ): void {
    office.immediate(() => resolveIntent(office, runId, intent.intentId, outcome, at));
  }

  /** The run's report feedback intents (the counter of AC #1). */
  reportFeedbacks(office: OfficeHandle, runId: RunId): StoredIntent[] {
    return runIntents(office, runId).filter(
      (intent) =>
        intent.kind === "steer" && intentTag(intent.detail) === INTENT_TAGS.reportFeedback,
    );
  }

  /** True when an agent of the run other than `agent` ended for `reason`. */
  endedAs(office: OfficeHandle, runId: string, agent: string, reason: string): boolean {
    return (
      office.get(
        `select 1 as found from agents where office_id = $office_id and run_id = $run
          and agent_id != $agent and end_reason = $reason`,
        { run: runId, agent, reason },
      ) !== null
    );
  }

  /** Records why the agent ended, replacing the ingestor's `exited` (a decision, so once). */
  endAgent(office: OfficeHandle, agent: string, reason: string): void {
    office.immediate(() => this.endAgentIn(office, agent, reason));
  }

  /** `#endAgent` inside the caller's transaction. */
  endAgentIn(office: OfficeHandle, agent: string, reason: string): void {
    office.run(
      `update agents set end_reason = $reason
        where office_id = $office_id and agent_id = $agent
          and (end_reason is null or end_reason = 'exited')`,
      { reason, agent },
    );
  }

  write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    const at = this.deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.deps.onChanged?.(office.officeId);
  }
}
