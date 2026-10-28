// What a turn or an event of a running worker asks of worker outcomes (DIPO-51, split out of
// `outcomes.ts` by DIPO-128): a turn's problem, the report feedback, a rejected plan limit and a
// classifier switch.

import type { RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { AdapterHold } from "../workers/hold";
import type { HostOp, TurnProblem } from "../workers/types";

import { sendFeedback } from "./feedback";
import { resolveIntent } from "./intents";
import type { OutcomeSupport } from "./outcome-support";
import {
  INTENT_TAGS,
  OUTCOME_ENDS,
  OUTCOME_NOTICES,
  type PlanLimitHit,
  type PlanLimitWarning,
  REASSIGN_SIGTERM_AFTER_MS,
  reportFeedbackText,
  type RunOutcomesDeps,
  type RunView,
  type WaitFact,
} from "./outcome-types";
import { raiseSignal } from "./signals";

export class TurnOutcomes {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;

  constructor(support: OutcomeSupport) {
    this.#s = support;
    this.#deps = support.deps;
  }

  async onTurnProblem(view: RunView, problem: TurnProblem): Promise<void> {
    const office = this.#deps.offices.get(view.office);
    const ender = this.#deps.ender();
    if (office === undefined || !ender.live(view.runId)) return;
    const close: HostOp[] = [
      { closeStdin: true },
      { signal: "SIGTERM", afterMs: REASSIGN_SIGTERM_AFTER_MS },
    ];
    switch (problem.kind) {
      case "planLimit":
        this.onPlanLimit(view, { credits: false });
        return;
      case "startFailed":
        // The worker cannot run: close it; the exit holds the adapter.
        ender.act(view.runId, {
          intent: "stop",
          detail: `${INTENT_TAGS.startFailed} ${problem.detail}`,
          ops: close,
          retryAtTick: true,
        });
        return;
      case "contextFull":
        if (this.#s.endedAs(office, view.runId, view.work.agent, "prompt-too-long")) {
          ender.begin(view.runId, {
            intent: "cap",
            ops: close,
            reason: "budget-exceeded",
            detail: "prompt_too_long: the context is full again after a handoff",
            endKind: OUTCOME_ENDS.capped,
          });
          return;
        }
        ender.act(view.runId, {
          intent: "reassign",
          detail: INTENT_TAGS.contextFull,
          ops: close,
          retryAtTick: true,
        });
        return;
      case "error": {
        const refused = this.#s.noRetry(office, view, view.work.agent);
        if (refused !== null) {
          ender.begin(view.runId, {
            intent: "park",
            ops: close,
            reason: "worker-failed",
            detail: `${problem.detail}${refused}`,
            endKind: OUTCOME_ENDS.crashed,
          });
          return;
        }
        ender.act(view.runId, {
          intent: "reassign",
          detail: `${INTENT_TAGS.error} ${problem.detail}`,
          ops: close,
          retryAtTick: true,
        });
        return;
      }
      case "report":
        // A report that does not parse or match the schema is a broken worker, not a question
        // (0008, 0001): after its one correction turn the story parks `worker-failed`.
        if (this.#s.reportFeedbacks(office, view.runId).length > 0) {
          ender.begin(view.runId, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason: "worker-failed",
            detail: `no valid report: ${problem.detail}`,
            endKind: OUTCOME_ENDS.noReport,
          });
          return;
        }
        // The one correction turn, keyed on the agent: a worker that exited before it read it
        // gets it with its resume's first message (`ExitOutcomes`).
        await sendFeedback(
          office,
          view.runId,
          { source: "report", key: view.work.agent, text: reportFeedbackText(problem.detail) },
          { sender: this.#deps },
        ).done;
        return;
    }
  }

  answered(view: RunView): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const open = this.#s
      .reportFeedbacks(office, view.runId)
      .filter((intent) => intent.resolvedAt === null && intent.state !== "pending");
    if (open.length === 0) return;
    const at = this.#deps.clock.now();
    office.immediate(() => {
      for (const intent of open) resolveIntent(office, view.runId, intent.intentId, "answered", at);
    });
  }

  onPlanLimit(view: RunView, limit: PlanLimitHit): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const since = this.#deps.clock.now();
    const fact: WaitFact = {
      scope: limit.credits ? "credits" : (limit.scope ?? "unknown"),
      ...(limit.resetsAt === undefined || limit.credits ? {} : { resetsAt: limit.resetsAt }),
      since,
    };
    const acted = this.#deps.ender().act(view.runId, {
      intent: "pause",
      detail: `${INTENT_TAGS.planLimit} ${JSON.stringify(fact)}`,
      ops: [{ closeStdin: true }],
    });
    if (!acted) return;
    this.hold(office, view.runId, view.work, fact);
  }

  onPlanWarning(view: RunView, warning: PlanLimitWarning): void {
    this.#deps.waits?.()?.warned(view.office, warning);
  }

  /** The signal, `work.observed plan-limit` and, for credits, the adapter hold and a notice. */
  hold(office: OfficeHandle, runId: RunId, work: WorkRef, fact: WaitFact): void {
    let held: AdapterHold | null = null;
    if (fact.scope === "credits") {
      held =
        this.#deps.holds?.hold(this.#deps.worker.id, [
          {
            check: "credits",
            detail:
              "the plan reports credits_required, so no run can use it until the plan is dealt with",
          },
        ]) ?? null;
    }
    this.#s.write(office, () => {
      const raised = raiseSignal(office, runId, "plan-limit", fact.since);
      const entries: NewEntry[] = [];
      if (raised !== null) {
        entries.push({
          type: "work.observed",
          key: work.key,
          run: runId,
          delta: { work, signal: "plan-limit", since: new Date(fact.since).toISOString() },
        });
      }
      if (fact.scope === "credits") {
        entries.push({
          type: "engine.notice",
          key: work.key,
          run: runId,
          delta: {
            level: "warn",
            code: OUTCOME_NOTICES.planLimit,
            text: `${work.story}: the plan needs credits; dipo holds the run with its session kept${held === null ? "" : " and holds new runs on the adapter"}. Deal with the plan, then resume the story.`,
          },
        });
      }
      return entries;
    });
    // The schedule holds the scope and resumes the run after the reset (DIPO-61).
    this.#deps.waits?.()?.waiting(office.officeId, runId, fact);
  }

  onModelSwitched(view: RunView, model: string): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    this.#s.write(office, () => [
      {
        type: "engine.notice",
        key: view.work.key,
        run: view.runId,
        delta: {
          level: "info",
          code: OUTCOME_NOTICES.modelSwitched,
          text: `${view.work.story}: the worker switched to ${model} (a classifier switch, planned ${view.work.model}); dipo recorded it on the run and goes on.`,
        },
      },
    ]);
  }
}
