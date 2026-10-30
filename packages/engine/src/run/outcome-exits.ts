// The decision at a worker's exit, or at a host found dead (DIPO-51, DIPO-57, split out of
// `outcomes.ts` by DIPO-128): by the intent that explains the exit, else by the adapter's result.

import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import type { HostOp } from "../workers/types";

import type { RunEnding } from "./control-types";
import { sendFeedback } from "./feedback";
import { resolveIntent, type StoredIntent } from "../records/intents";
import type { OutcomeSupport } from "./outcome-support";
import type { SessionStarts } from "./outcome-sessions";
import {
  type ExitContext,
  HOST_LOST_WHY,
  initRejectedEnding,
  INTENT_TAGS,
  intentRest,
  intentTag,
  planLimitEnding,
  reportFeedbackText,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import { findRun, type StoredRun } from "../records/run-records";
import { planLimitPause } from "./starts-paused";

export class ExitOutcomes {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeSupport["guard"];
  readonly #sessions: SessionStarts;

  constructor(support: OutcomeSupport, sessions: SessionStarts) {
    this.#s = support;
    this.#deps = support.deps;
    this.#guard = support.guard;
    this.#sessions = sessions;
  }

  async onExit(exit: ExitContext): Promise<void> {
    const key = `${exit.view.runId} ${exit.agent}`;
    if (this.#guard.has(key)) return;
    await this.#guard.within(key, () => this.#decideExit(exit));
  }

  /**
   * The decision on a host that was lost (its agent ended `host-lost`, 0005, 0008): the story parks
   * `worker-failed`, with no resume. Re-attach parks a host it finds dead at recovery itself; this
   * is for a lost host the restart found decided and not yet parked.
   */
  async hostLost(office: OfficeHandle, run: StoredRun, view: RunView): Promise<void> {
    await this.#s.park(office, run, view.work, {
      intent: "park",
      ops: [],
      reason: "worker-failed",
      detail: HOST_LOST_WHY,
    });
  }

  async #decideExit(exit: ExitContext): Promise<void> {
    await exit.turns.catch(() => undefined);
    await exit.ending?.catch(() => undefined);
    const { view, agent } = exit;
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const run = findRun(office, view.runId);
    if (run === null) return;
    const at = this.#deps.clock.now();
    const intent = this.#s.explaining(office, view.runId);
    if (run.endedAt !== null) {
      if (intent !== null)
        this.#s.resolve(office, view.runId, intent, this.#s.outcomeOf(intent), at);
      return;
    }
    if (intent !== null) {
      await this.#byIntent(office, run, view, agent, intent);
      return;
    }
    // This worker exited before it answered its report correction: the correction is held again
    // for the resume's first message (the one feedback path), keyed on this agent, so a restart
    // before the resume started resumes again. It is delivered once the next session started.
    const feedback = this.#s
      .reportFeedbacks(office, view.runId)
      .find((row) => row.resolvedAt === null && row.key === agent);
    if (feedback !== undefined) {
      if (feedback.via === "now") {
        office.immediate(() => {
          resolveIntent(office, view.runId, feedback.intentId, "held-again", at);
          sendFeedback(
            office,
            view.runId,
            { source: "report", key: agent, text: feedback.text },
            { at },
          );
        });
      }
      await this.#sessions.next(office, run, view, {
        mode: "resume",
        why: "the worker exited before it answered the report feedback",
      });
      return;
    }
    await this.#byResult(office, run, view, agent, exit.end);
  }

  async #byIntent(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
    intent: StoredIntent,
  ): Promise<void> {
    const at = this.#deps.clock.now();
    const tag = intentTag(intent.detail);
    // The intent is resolved in the transaction that records why the agent ended (DIPO-57), so a
    // restart before the next session started finds the decision and starts that session.
    if (intent.kind === "reassign" && tag === INTENT_TAGS.contextFull) {
      office.immediate(() => {
        resolveIntent(office, view.runId, intent.intentId, "reassigned", at);
        this.#s.endAgentIn(office, agent, "prompt-too-long");
      });
      await this.#sessions.next(office, run, view, {
        mode: "handoff",
        why: "a full context (prompt_too_long)",
      });
      return;
    }
    if (intent.kind === "reassign" && tag === INTENT_TAGS.error) {
      office.immediate(() => {
        resolveIntent(office, view.runId, intent.intentId, "reassigned", at);
        this.#s.endAgentIn(office, agent, "crashed");
      });
      await this.#sessions.next(office, run, view, {
        mode: "resume",
        why: `an execution error (${intentRest(intent.detail)})`,
      });
      return;
    }
    if (intent.kind === "stop" && tag === INTENT_TAGS.startFailed) {
      this.#s.resolve(office, view.runId, intent, "startFailed", at);
      await this.#sessions.startFailed(office, run, view.work, intentRest(intent.detail), null);
      return;
    }
    // A stop, cap or park whose park did not end the run: the exit is explained all the same.
    this.#s.resolve(office, view.runId, intent, this.#s.outcomeOf(intent), at);
  }

  async #byResult(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
    end: IngestedExit,
  ): Promise<void> {
    const result = this.#deps.worker.result(end.state, end.exit);
    const park = (ending: Omit<RunEnding, "ops"> & { readonly ops?: readonly HostOp[] }) =>
      this.#s.park(office, run, view.work, { ops: [], ...ending });
    switch (result.outcome) {
      case "initRejected": {
        const reason = result.park?.detail ?? "the start checks failed";
        await park(initRejectedEnding(view.work.story, reason));
        return;
      }
      case "startFailed":
        await this.#sessions.startFailed(
          office,
          run,
          view.work,
          result.detail ?? "the worker did not start",
          null,
        );
        return;
      case "plan-limit": {
        // An exit the adapter reads as a plan limit, with no event that named its reset (0020).
        const pause = planLimitPause({ credits: false }, this.#deps.clock.now());
        this.#deps.startsPaused?.()?.pausePlanLimit(view.office, pause);
        await park(planLimitEnding(pause, []));
        return;
      }
      case "capped":
        if (result.retry === "handoff") {
          if (this.#s.endedAs(office, run.runId, agent, "prompt-too-long")) {
            await park({
              intent: "cap",
              reason: "budget-exceeded",
              detail: "prompt_too_long: the context is full again after a handoff",
            });
            return;
          }
          this.#s.endAgent(office, agent, "prompt-too-long");
          await this.#sessions.next(office, run, view, {
            mode: "handoff",
            why: "a full context (prompt_too_long)",
          });
          return;
        }
        await park({
          intent: "cap",
          reason: result.park?.reason ?? "budget-exceeded",
          detail: result.park?.detail ?? "the worker stopped at a cap",
        });
        return;
      case "blocked":
        if (result.retry === "report-feedback") {
          const why = (result.park?.detail ?? "no valid report: no report").replace(
            /^no valid report: /,
            "",
          );
          // A report that does not parse or match the schema is a broken worker (0008, 0001).
          if (this.#s.reportFeedbacks(office, run.runId).length > 0) {
            await park({
              intent: "park",
              reason: "worker-failed",
              detail: `no valid report: ${why}`,
            });
            return;
          }
          // The one correction turn, held for the resume's first message and keyed on this agent,
          // so a restart before the resume started resumes with it again (`#decideExit`).
          sendFeedback(
            office,
            run.runId,
            { source: "report", key: agent, text: reportFeedbackText(why) },
            { at: this.#deps.clock.now() },
          );
          await this.#sessions.next(office, run, view, {
            mode: "resume",
            why: "a turn without a valid report",
          });
          return;
        }
        await park({
          intent: "park",
          reason: result.park?.reason ?? "ambiguous-spec",
          detail: result.park?.detail ?? "the worker is blocked",
          report: result.report,
        });
        return;
      case "crashed":
        await this.#crashed(office, run, view, agent, result.park?.detail ?? "the worker crashed");
        return;
      default:
        // `done` is verify and commit's (DIPO-49); `stopped` and `reassigned` come from intents.
        return;
    }
  }

  /** A crash: one resume when no earlier agent crashed and no cap fired, else `worker-failed`. */
  async #crashed(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
    detail: string,
  ): Promise<void> {
    const refused = this.#s.noRetry(office, view, agent);
    if (refused !== null) {
      await this.#s.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${detail}${refused}`,
      });
      return;
    }
    this.#s.endAgent(office, agent, "crashed");
    await this.#sessions.next(office, run, view, { mode: "resume", why: `a crash (${detail})` });
  }
}
