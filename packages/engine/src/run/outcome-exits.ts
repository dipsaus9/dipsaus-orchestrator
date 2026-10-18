// The decision at a worker's exit, or at a host found dead (DIPO-51, DIPO-57, split out of
// `outcomes.ts` by DIPO-128): by the intent that explains the exit, else by the adapter's result.

import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import { recoverTranscriptUsage } from "../ingest/transcript";
import { finalizeAgentUsage } from "../ingest/usage";
import type { HostOp } from "../workers/types";

import type { RunEnding } from "./control-types";
import { markIntentSent, recordIntent, resolveIntent, type StoredIntent } from "./intents";
import type { OutcomeSupport } from "./outcome-support";
import type { SessionStarts } from "./outcome-sessions";
import type { TurnOutcomes } from "./outcome-turns";
import {
  type ExitContext,
  feedbackOf,
  HOST_LOST_END,
  HOST_LOST_WHY,
  initRejectedEnding,
  INTENT_TAGS,
  intentRest,
  intentTag,
  type HostLostContext,
  OUTCOME_ENDS,
  reportFeedbackText,
  type RunOutcomesDeps,
  type RunView,
  type WaitFact,
} from "./outcome-types";
import { findRun, type StoredRun } from "./records";
import { raiseSignal } from "./signals";

export class ExitOutcomes {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeSupport["guard"];
  readonly #sessions: SessionStarts;
  readonly #turns: TurnOutcomes;

  constructor(support: OutcomeSupport, sessions: SessionStarts, turns: TurnOutcomes) {
    this.#s = support;
    this.#deps = support.deps;
    this.#guard = support.guard;
    this.#sessions = sessions;
    this.#turns = turns;
  }

  async onExit(exit: ExitContext): Promise<void> {
    const key = `${exit.view.runId} ${exit.agent}`;
    if (this.#guard.has(key)) return;
    await this.#guard.within(key, () => this.#decideExit(exit));
  }

  /**
   * A host found dead after a restart, with no `exit.json` and no exit line (0006 decision 8,
   * 0008 section 7): `work.observed host-lost` (health `lost`) and the agent ends `host-lost`;
   * then as a crash row, except that only a resume will do: the session is resumed once when
   * budget remains and `canResume` holds (the dead agent's usage finalized first), else the story
   * parks `interrupted`. An intent from before the stop that explains an exit decides it instead.
   */
  async onHostLost(lost: HostLostContext): Promise<void> {
    const key = `${lost.view.runId} ${lost.agent}`;
    if (this.#guard.has(key)) return;
    await this.#guard.within(key, () => this.#decideHostLost(lost));
  }

  async #decideHostLost(lost: HostLostContext): Promise<void> {
    await lost.ending?.catch(() => undefined);
    const { view, agent } = lost;
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const intent = this.#s.explaining(office, view.runId);
    const at = this.#deps.clock.now();
    this.#readTranscripts(office, view, agent, at);
    // The agent ends with the signal in one transaction: a restart before the decision below
    // finds `host-lost` and decides it again.
    this.#s.write(office, () => {
      office.run(
        `update agents set ended_at = coalesce(ended_at, $at),
             end_reason = coalesce(end_reason, $reason)
           where office_id = $office_id and agent_id = $agent`,
        { at, agent, reason: intent === null ? HOST_LOST_END : "exited" },
      );
      office.run(
        `update ingest_cursors set ended_at = coalesce(ended_at, $at)
            where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { at, run: view.runId, agent },
      );
      office.run(
        `update worker_hosts set ended_at = coalesce(ended_at, $at)
            where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { at, run: view.runId, agent },
      );
      const raised = raiseSignal(office, view.runId, "host-lost", at);
      if (raised === null) return [];
      return [
        {
          type: "work.observed",
          key: view.work.key,
          run: view.runId,
          delta: { work: view.work, signal: "host-lost", since: new Date(at).toISOString() },
        },
      ];
    });
    const run = findRun(office, view.runId);
    if (run === null) return;
    if (run.endedAt !== null) {
      if (intent !== null)
        this.#s.resolve(office, view.runId, intent, this.#s.outcomeOf(intent), at);
      return;
    }
    if (intent !== null) {
      await this.#byIntent(office, run, view, agent, intent);
      return;
    }
    await this.hostLost(office, run, view, agent);
  }

  /**
   * The usage a dead host never wrote to `exit.json` is read from the worker's transcript
   * (0008 section 4, DIPO-134), once per message id. A transcript that cannot be read costs the
   * usage, never the decision.
   */
  #readTranscripts(office: OfficeHandle, view: RunView, agent: string, at: number): void {
    const read = this.#deps.worker.readTranscript;
    if (read === undefined) return;
    try {
      const pass = recoverTranscriptUsage({
        office,
        scope: {
          run: view.runId,
          agent,
          role: view.work.role,
          tier: view.work.tier,
          budgetLimit: view.caps.budgetTokens,
        },
        read,
        pricing: this.#deps.pricing?.() ?? null,
        mode: "lost",
        at,
      });
      if (pass.refused !== null) {
        this.#deps.warn?.("the worker transcript was not read", {
          run: view.runId,
          agent,
          reason: pass.refused,
        });
      }
    } catch (error) {
      this.#deps.warn?.("reading the worker transcript failed", {
        run: view.runId,
        agent,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The decision on an agent that ended `host-lost`: one resume, else park `interrupted`. */
  async hostLost(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
  ): Promise<void> {
    const refused = this.#s.noRetry(office, view, agent);
    if (refused !== null) {
      const suffix = refused === "" ? "; dipo cannot start another session of the run" : refused;
      await this.#s.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "interrupted",
        detail: `${HOST_LOST_WHY}${suffix}`,
        endKind: OUTCOME_ENDS.interrupted,
      });
      return;
    }
    // The dead agent's usage is final before the resumed session adds its own (AC #9).
    office.immediate(() => finalizeAgentUsage(office, run.runId, agent, this.#deps.clock.now()));
    await this.#sessions.next(office, run, view, {
      mode: "resume",
      why: HOST_LOST_WHY,
      requireResume: true,
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
    // This worker exited before it answered its report feedback: resume with it. The feedback
    // is resolved only once the next session started, so a restart in between resumes again.
    const feedback = this.#s
      .reportFeedbacks(office, view.runId)
      .find((row) => row.resolvedAt === null && feedbackOf(row.detail).agent === agent);
    if (feedback !== undefined) {
      const started = await this.#sessions.next(office, run, view, {
        mode: "resume",
        why: "the worker exited before it answered the report feedback",
        message: reportFeedbackText(feedbackOf(feedback.detail).why),
      });
      if (started) this.#s.resolve(office, view.runId, feedback, "resumed", this.#deps.clock.now());
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
    if (intent.kind === "pause" && tag === INTENT_TAGS.planLimit) {
      // The run waits for the reset with its claim and session (DIPO-61 resumes it).
      this.#s.resolve(office, view.runId, intent, "plan-limit", at);
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
        const fact: WaitFact = { scope: "unknown", since: this.#deps.clock.now() };
        const intentId = office.immediate(() =>
          recordIntent(
            office,
            run.runId,
            "pause",
            `${INTENT_TAGS.planLimit} ${JSON.stringify(fact)}`,
            fact.since,
          ),
        );
        office.immediate(() =>
          resolveIntent(office, run.runId, intentId, "plan-limit", fact.since),
        );
        this.#turns.hold(office, run.runId, view.work, fact);
        return;
      }
      case "capped":
        if (result.retry === "handoff") {
          if (this.#s.endedAs(office, run.runId, agent, "prompt-too-long")) {
            await park({
              intent: "cap",
              reason: "budget-exceeded",
              detail: "prompt_too_long: the context is full again after a handoff",
              endKind: OUTCOME_ENDS.capped,
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
          endKind: OUTCOME_ENDS.capped,
        });
        return;
      case "blocked":
        if (result.retry === "report-feedback") {
          const why = (result.park?.detail ?? "no valid report: no report").replace(
            /^no valid report: /,
            "",
          );
          if (this.#s.reportFeedbacks(office, run.runId).length > 0) {
            await park({
              intent: "park",
              reason: "ambiguous-spec",
              detail: `no valid report: ${why}`,
              endKind: OUTCOME_ENDS.noReport,
            });
            return;
          }
          // The one feedback turn, as the first message of a resume; resolved once it started.
          const at = this.#deps.clock.now();
          const id = office.immediate(() => {
            const recorded = recordIntent(
              office,
              run.runId,
              "steer",
              `${INTENT_TAGS.reportFeedback} ${agent} ${why}`,
              at,
            );
            markIntentSent(office, run.runId, recorded, at, null);
            return recorded;
          });
          const started = await this.#sessions.next(office, run, view, {
            mode: "resume",
            why: "a turn without a valid report",
            message: reportFeedbackText(why),
          });
          if (started) {
            const now = this.#deps.clock.now();
            office.immediate(() => resolveIntent(office, run.runId, id, "resumed", now));
          }
          return;
        }
        await park({
          intent: "park",
          reason: result.park?.reason ?? "ambiguous-spec",
          detail: result.park?.detail ?? "the worker is blocked",
          endKind: OUTCOME_ENDS.blocked,
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
        endKind: OUTCOME_ENDS.crashed,
      });
      return;
    }
    this.#s.endAgent(office, agent, "crashed");
    await this.#sessions.next(office, run, view, { mode: "resume", why: `a crash (${detail})` });
  }
}
