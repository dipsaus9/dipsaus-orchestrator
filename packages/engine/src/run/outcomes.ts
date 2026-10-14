// Worker outcomes (DIPO-51; 0008 sections 2, 7 and 8, 0014 section 6). Run control hands this
// every turn problem, rejected init, plan limit and classifier switch of a tracked run, and the
// worker's exit once the turns before it are handled. Every op is stored as a `run_intents` row
// before it is sent; DIPO-51's intents carry a tag at the start of their detail:
//
// - `steer` `report-feedback <why>`: a turn without a valid report gets one feedback turn "report
//   in the schema" (`prompts/feedback/report.md`); the next turn answers it. A second turn without
//   one parks `ambiguous-spec` ("no valid report: <why>", end kind `no-report`). A worker that
//   exits before it answered is resumed with the feedback as its first message.
// - `reassign` `new-session:context-full`: a turn ended `prompt_too_long`; stdin is closed and
//   SIGTERM follows after 10 s. At the exit the agent ends `prompt-too-long` and one new session
//   with a handoff starts. A second full context parks `budget-exceeded` (end kind `capped`).
// - `reassign` `new-session:error`: a turn ended in an execution error while the process waits
//   (maintainer decision Q4): a crash, handled at the exit as one.
// - A crash with no intent (a signal, exit 143, an execution error, a cut stream): usage is
//   already recovered by ingestion; when no earlier agent of the run crashed and no cap fired, the
//   agent ends `crashed` and the session is resumed once (`--resume` when `canResume` holds, else a
//   handoff). Otherwise the story parks `worker-failed` with the last error.
// - `stop` `init-rejected`: a `system/init` that fails its checks (key source, model) stops the
//   worker at once (stdin closed, SIGTERM now, SIGKILL after 30 s) and parks `worker-failed` with
//   an `engine.notice` `run.initRejected` (end kind `init-rejected`).
// - `stop` `start-failed`: a start failure (startup failure, authentication, billing, account on
//   hold) holds the adapter (DIPO-43's hold) and raises `run.startFailed`. When the worktree holds
//   no work the claim is released as DIPO-74 does (worktree removed, branch kept, story Ready);
//   when it holds commits past the claim or a dirty tree, the story parks `worker-failed` and
//   everything is kept (0008 amendment of 2026-10-14).
// - `pause` `plan-limit {scope, resetsAt?, since}`: a rejected plan limit (a `rate_limit_event`
//   `rejected`, `credits_required`, or a 429 turn) closes stdin, writes the wait fact on the run,
//   raises the `plan-limit` signal with `work.observed plan-limit` (health `limited`), and never
//   parks: run and claim stay. `credits` also holds the adapter with a notice. Waiting for the
//   reset is DIPO-61's (`openWait`).
// - A classifier switch is recorded in the session's parser state and announced once per run and
//   model with `engine.notice` `run.modelSwitched`; it never parks.
//
// Each counter fires once per run and they are independent (maintainer decision Q5); they are
// read from facts (`run_intents`, `agents.end_reason`), so a restart keeps them. Every run that
// ends goes through `endRun` (a park, or the claim release of a start failure).

import type { Clock, OfficeId, RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import { workRefOf, withWorkViews } from "../views/work";
import { type AdapterHold, holdMessage, type LaunchCheckFailure } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import type { Caps, HostOp, SteerOp, TurnProblem } from "../workers/types";
import { type ClaimRecord, findClaim, releaseClaim } from "../worktree/records";

import type { BackstopSnapshot } from "./backstop";
import { firedCap, runTotals } from "./caps";
import type { RunEnding, RunSteering } from "./control";
import {
  type IntentKind,
  markIntentSent,
  recordIntent,
  resolveIntent,
  runIntents,
  type StoredIntent,
} from "./intents";
import { START_FAILED_END } from "./launch";
import type { ParkOutcome } from "./park";
import { activeRuns, findRun, type StoredRun } from "./records";
import type { NextSession } from "./resume";
import { activeSignals, raiseSignal } from "./signals";
import type { StoryGit } from "./story-git";

/** The tags DIPO-51 stores at the start of an intent's detail. */
export const INTENT_TAGS = {
  reportFeedback: "report-feedback",
  contextFull: "new-session:context-full",
  error: "new-session:error",
  planLimit: "plan-limit",
  initRejected: "init-rejected",
  startFailed: "start-failed",
} as const;

/** `engine.notice` codes of worker outcomes. */
export const OUTCOME_NOTICES = {
  initRejected: "run.initRejected",
  modelSwitched: "run.modelSwitched",
  startFailed: "run.startFailed",
  planLimit: "run.planLimit",
  feedbackNotSent: "run.feedbackNotSent",
} as const;

/** End kinds of worker outcomes (`runs.end_kind`). */
export const OUTCOME_ENDS = {
  noReport: "no-report",
  initRejected: "init-rejected",
  crashed: "crashed",
  capped: "capped",
  blocked: "blocked",
} as const;

/** Milliseconds from closing stdin to SIGTERM for a reassign (0008 section 6). */
export const REASSIGN_SIGTERM_AFTER_MS = 10_000;
/** Milliseconds to SIGKILL after a rejected init. */
export const INIT_REJECTED_SIGKILL_AFTER_MS = 30_000;

/** The office load step that decides exits a restart left undecided (maintainer decision Q6). */
export const REDISPATCH_STEP = "run-outcomes/redispatch";

/**
 * The real `RunOutcomesDeps.holdsWork`: the worktree holds work when HEAD moved past the claim
 * commit or the tree is dirty (0008 amendment of 2026-10-14).
 */
export function storyHoldsWork(
  story: Pick<StoryGit, "snapshot" | "changedPaths">,
): NonNullable<RunOutcomesDeps["holdsWork"]> {
  return async (office, run, claim) => {
    if (run.worktree === null || claim === null) return false;
    const now = await story.snapshot(office, run.worktree);
    if (now.head !== (claim.claimSha ?? claim.startSha)) return true;
    return (await story.changedPaths(office, run.worktree)).length > 0;
  };
}

/** The tag of an intent's detail: its first word. */
export function intentTag(detail: string): string {
  const space = detail.indexOf(" ");
  return space === -1 ? detail : detail.slice(0, space);
}

/** The detail after an intent's tag. */
function intentRest(detail: string): string {
  const space = detail.indexOf(" ");
  return space === -1 ? "" : detail.slice(space + 1);
}

/** The wait fact of a plan-limit hold (0008 section 7, maintainer decision Q3a). */
export interface WaitFact {
  readonly scope: "unknown" | "credits";
  /** ISO time the limit resets, when the event said. */
  readonly resetsAt?: string;
  /** When the wait began, on the engine clock. */
  readonly since: number;
}

/**
 * The run's open plan-limit wait, or null: the newest `pause` `plan-limit` intent while the
 * `plan-limit` signal is in effect (DIPO-61 reads it to resume after the reset and clears the
 * signal when it does).
 */
export function openWait(office: OfficeHandle, runId: string): WaitFact | null {
  if (!activeSignals(office, runId).some((signal) => signal.signal === "plan-limit")) return null;
  const intent = runIntents(office, runId as RunId)
    .filter((row) => row.kind === "pause" && intentTag(row.detail) === INTENT_TAGS.planLimit)
    .at(-1);
  if (intent === undefined) return null;
  try {
    return JSON.parse(intentRest(intent.detail)) as WaitFact;
  } catch {
    return null;
  }
}

/** A tracked run as run control hands it over. */
export interface RunView {
  readonly office: OfficeId;
  readonly runId: RunId;
  readonly work: WorkRef;
  readonly caps: Caps;
  /** When the run's first worker started, on the engine clock. */
  readonly startedAt: number;
  readonly snapshot: BackstopSnapshot | null;
}

/** An op stored as an intent and sent without a park. */
export interface RunAct {
  readonly intent: IntentKind;
  readonly detail: string;
  readonly ops: readonly HostOp[];
}

/** What worker outcomes ask of run control. */
export interface RunEnder {
  /** True while the run is tracked and nothing was decided for it. */
  live(runId: string): boolean;
  /** The first decision on a tracked run, parking it; false when one was made already. */
  begin(runId: string, ending: RunEnding): boolean;
  /** The first decision on a tracked run without a park; false when one was made already. */
  act(runId: string, act: RunAct): boolean;
  /** Parks a run whose worker exited. */
  park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: RunEnding,
  ): Promise<ParkOutcome>;
}

/** A worker's exit as run control hands it over. */
export interface ExitContext {
  readonly view: RunView;
  readonly agent: string;
  /** The after-turn work of the run's turns before the exit. */
  readonly turns: Promise<void>;
  /** A decision under way, or null. */
  readonly ending: Promise<unknown> | null;
  readonly end: IngestedExit;
}

/** What run control calls. */
export interface RunOutcomesPort {
  onTurnProblem(view: RunView, problem: TurnProblem): Promise<void>;
  onPlanLimit(
    view: RunView,
    limit: { readonly credits: boolean; readonly resetsAt?: string },
  ): void;
  onModelSwitched(view: RunView, model: string): void;
  /** A turn arrived: an open report feedback is answered. */
  answered(view: RunView): void;
  onExit(exit: ExitContext): Promise<void>;
}

/** The ending of a rejected init (0008 sections 2 and 7). */
export function initRejectedEnding(story: string, reason: string): RunEnding {
  return {
    intent: "stop",
    intentDetail: `${INTENT_TAGS.initRejected} ${reason}`,
    ops: [
      { closeStdin: true },
      { signal: "SIGTERM" },
      { signal: "SIGKILL", afterMs: INIT_REJECTED_SIGKILL_AFTER_MS },
    ],
    reason: "worker-failed",
    detail: `the worker failed its start checks: ${reason}`,
    endKind: OUTCOME_ENDS.initRejected,
    notice: {
      level: "error",
      code: OUTCOME_NOTICES.initRejected,
      text: `${story}: dipo stopped the worker because its start failed the checks (${reason}) and parked the story as worker-failed.`,
    },
  };
}

export interface RunOutcomesDeps {
  readonly clock: Clock;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
  readonly steering: RunSteering;
  readonly encode: (op: SteerOp) => HostOp[];
  /** The worker port's id and pure `result`. */
  readonly worker: Pick<WorkerPort, "id" | "result">;
  /** Run control; read when needed, since it is built with this as its outcomes. */
  readonly ender: () => RunEnder;
  /** Starts the run's next session; without it every crash parks `worker-failed`. */
  readonly resumer?: NextSession;
  /** DIPO-43's adapter hold, set for start failures and credit limits. */
  readonly holds?: {
    hold(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterHold;
  };
  /** Releases a live claim whose worker did not start (DIPO-74's release). */
  readonly release?: (office: OfficeId, claim: ClaimRecord, reason: string) => Promise<void>;
  /** True when the run's worktree has commits past the claim commit or a dirty tree. */
  readonly holdsWork?: (
    office: OfficeId,
    run: StoredRun,
    claim: ClaimRecord | null,
  ) => Promise<boolean>;
  /** The caps of a run that is no longer tracked (after a restart). */
  readonly caps?: (office: OfficeId, run: StoredRun) => Caps | null;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export class RunOutcomes implements RunOutcomesPort {
  readonly #deps: RunOutcomesDeps;

  constructor(deps: RunOutcomesDeps) {
    this.#deps = deps;
  }

  // ---- after a turn --------------------------------------------------------------------------

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
        });
        return;
      case "contextFull":
        if (this.#endedAs(office, view.runId, view.work.agent, "prompt-too-long")) {
          ender.begin(view.runId, {
            intent: "cap",
            ops: close,
            reason: "budget-exceeded",
            detail: "prompt_too_long: the context is full again after a handoff",
            endKind: OUTCOME_ENDS.capped,
          });
          return;
        }
        ender.act(view.runId, { intent: "reassign", detail: INTENT_TAGS.contextFull, ops: close });
        return;
      case "error": {
        const refused = this.#noRetry(office, view, view.work.agent);
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
        });
        return;
      }
      case "report":
        if (this.#reportFeedbacks(office, view.runId).length > 0) {
          ender.begin(view.runId, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason: "ambiguous-spec",
            detail: `no valid report: ${problem.detail}`,
            endKind: OUTCOME_ENDS.noReport,
          });
          return;
        }
        await this.#sendReportFeedback(office, view, problem.detail);
        return;
    }
  }

  /** The one feedback turn for a missing or invalid report, stored first as a `steer` intent. */
  async #sendReportFeedback(office: OfficeHandle, view: RunView, why: string): Promise<void> {
    const intentId = office.immediate(() =>
      recordIntent(
        office,
        view.runId,
        "steer",
        `${INTENT_TAGS.reportFeedback} ${why}`,
        this.#deps.clock.now(),
      ),
    );
    let error: string | null = null;
    try {
      const sent = await this.#deps.steering.send(
        office,
        view.runId,
        this.#deps.encode({ kind: "steer", text: reportFeedbackText(why) }),
      );
      if (!sent.ok) error = sent.reason;
    } catch (thrown) {
      error = messageOf(thrown);
    }
    const at = this.#deps.clock.now();
    office.immediate(() => markIntentSent(office, view.runId, intentId, at, error));
    // A worker that exited before it read the feedback gets it as its resume's first message.
  }

  answered(view: RunView): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const open = this.#reportFeedbacks(office, view.runId).filter(
      (intent) => intent.resolvedAt === null && intent.state !== "pending",
    );
    if (open.length === 0) return;
    const at = this.#deps.clock.now();
    office.immediate(() => {
      for (const intent of open) resolveIntent(office, view.runId, intent.intentId, "answered", at);
    });
  }

  onPlanLimit(
    view: RunView,
    limit: { readonly credits: boolean; readonly resetsAt?: string },
  ): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const since = this.#deps.clock.now();
    const fact: WaitFact = {
      scope: limit.credits ? "credits" : "unknown",
      ...(limit.resetsAt === undefined || limit.credits ? {} : { resetsAt: limit.resetsAt }),
      since,
    };
    const acted = this.#deps.ender().act(view.runId, {
      intent: "pause",
      detail: `${INTENT_TAGS.planLimit} ${JSON.stringify(fact)}`,
      ops: [{ closeStdin: true }],
    });
    if (!acted) return;
    this.#hold(office, view.runId, view.work, fact);
  }

  /** The signal, `work.observed plan-limit` and, for credits, the adapter hold and a notice. */
  #hold(office: OfficeHandle, runId: RunId, work: WorkRef, fact: WaitFact): void {
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
    this.#write(office, () => {
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
  }

  onModelSwitched(view: RunView, model: string): void {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    this.#write(office, () => [
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

  // ---- at the exit ---------------------------------------------------------------------------

  async onExit(exit: ExitContext): Promise<void> {
    await exit.turns.catch(() => undefined);
    await exit.ending?.catch(() => undefined);
    const { view, agent } = exit;
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const run = findRun(office, view.runId);
    if (run === null) return;
    const at = this.#deps.clock.now();
    const intent = this.#explaining(office, view.runId);
    if (run.endedAt !== null) {
      if (intent !== null) this.#resolve(office, view.runId, intent, this.#outcomeOf(intent), at);
      return;
    }
    if (intent !== null) {
      await this.#byIntent(office, run, view, agent, intent);
      return;
    }
    // The worker exited before it answered the report feedback: resume with it.
    const feedback = this.#reportFeedbacks(office, view.runId).find(
      (row) => row.resolvedAt === null,
    );
    if (feedback !== undefined) {
      this.#resolve(office, view.runId, feedback, "resumed", at);
      await this.#next(office, run, view, {
        mode: "resume",
        why: "the worker exited before it answered the report feedback",
        message: reportFeedbackText(intentRest(feedback.detail)),
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
    if (intent.kind === "reassign" && tag === INTENT_TAGS.contextFull) {
      this.#resolve(office, view.runId, intent, "reassigned", at);
      this.#endAgent(office, agent, "prompt-too-long");
      await this.#next(office, run, view, {
        mode: "handoff",
        why: "a full context (prompt_too_long)",
      });
      return;
    }
    if (intent.kind === "reassign" && tag === INTENT_TAGS.error) {
      this.#resolve(office, view.runId, intent, "reassigned", at);
      this.#endAgent(office, agent, "crashed");
      await this.#next(office, run, view, {
        mode: "resume",
        why: `an execution error (${intentRest(intent.detail)})`,
      });
      return;
    }
    if (intent.kind === "pause" && tag === INTENT_TAGS.planLimit) {
      // The run waits for the reset with its claim and session (DIPO-61 resumes it).
      this.#resolve(office, view.runId, intent, "plan-limit", at);
      return;
    }
    if (intent.kind === "stop" && tag === INTENT_TAGS.startFailed) {
      this.#resolve(office, view.runId, intent, "startFailed", at);
      await this.#startFailed(office, run, view.work, intentRest(intent.detail), null);
      return;
    }
    // A stop, cap or park whose park did not end the run: the exit is explained all the same.
    this.#resolve(office, view.runId, intent, this.#outcomeOf(intent), at);
  }

  async #byResult(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
    end: IngestedExit,
  ): Promise<void> {
    const result = this.#deps.worker.result(end.state, end.exit);
    const ender = this.#deps.ender();
    const park = (ending: Omit<RunEnding, "ops"> & { readonly ops?: readonly HostOp[] }) =>
      ender.park(office, run, view.work, { ops: [], ...ending });
    switch (result.outcome) {
      case "initRejected": {
        const reason = result.park?.detail ?? "the start checks failed";
        await park(initRejectedEnding(view.work.story, reason));
        return;
      }
      case "startFailed":
        await this.#startFailed(
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
        this.#hold(office, run.runId, view.work, fact);
        return;
      }
      case "capped":
        if (result.retry === "handoff") {
          if (this.#endedAs(office, run.runId, agent, "prompt-too-long")) {
            await park({
              intent: "cap",
              reason: "budget-exceeded",
              detail: "prompt_too_long: the context is full again after a handoff",
              endKind: OUTCOME_ENDS.capped,
            });
            return;
          }
          this.#endAgent(office, agent, "prompt-too-long");
          await this.#next(office, run, view, {
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
          if (this.#reportFeedbacks(office, run.runId).length > 0) {
            await park({
              intent: "park",
              reason: "ambiguous-spec",
              detail: `no valid report: ${why}`,
              endKind: OUTCOME_ENDS.noReport,
            });
            return;
          }
          // The one feedback turn, as the first message of a resume.
          const at = this.#deps.clock.now();
          office.immediate(() => {
            const id = recordIntent(
              office,
              run.runId,
              "steer",
              `${INTENT_TAGS.reportFeedback} ${why}`,
              at,
            );
            markIntentSent(office, run.runId, id, at, null);
            resolveIntent(office, run.runId, id, "resumed", at);
          });
          await this.#next(office, run, view, {
            mode: "resume",
            why: "a turn without a valid report",
            message: reportFeedbackText(why),
          });
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
    const refused = this.#noRetry(office, view, agent);
    if (refused !== null) {
      await this.#deps.ender().park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${detail}${refused}`,
        endKind: OUTCOME_ENDS.crashed,
      });
      return;
    }
    this.#endAgent(office, agent, "crashed");
    await this.#next(office, run, view, { mode: "resume", why: `a crash (${detail})` });
  }

  /** Why a crash gets no retry, as a detail suffix; null when it gets one. */
  #noRetry(office: OfficeHandle, view: RunView, agent: string): string | null {
    if (this.#deps.resumer === undefined) return "";
    if (this.#endedAs(office, view.runId, agent, "crashed")) {
      return "; the run's one resume after a crash was used";
    }
    const cap = firedCap(
      view.caps,
      runTotals(office, view.runId, view.startedAt, this.#deps.clock.now()),
    );
    if (cap !== null) return `; no budget remains (${cap.detail})`;
    return null;
  }

  /** Starts the next session; a session that cannot start parks or releases the story. */
  async #next(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    request: {
      readonly mode: "resume" | "handoff";
      readonly why: string;
      readonly message?: string;
    },
  ): Promise<void> {
    const resumer = this.#deps.resumer;
    const ender = this.#deps.ender();
    if (resumer === undefined) {
      await ender.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${request.why}; dipo cannot start another session of the run`,
        endKind: OUTCOME_ENDS.crashed,
      });
      return;
    }
    let outcome;
    try {
      outcome = await resumer.next({
        office: view.office,
        run,
        work: view.work,
        mode: request.mode,
        why: request.why,
        ...(request.message === undefined ? {} : { message: request.message }),
        caps: view.caps,
        startedAt: view.startedAt,
        snapshot: view.snapshot,
      });
    } catch (error) {
      outcome = { kind: "failed" as const, reason: messageOf(error) };
    }
    switch (outcome.kind) {
      case "started":
        return;
      case "startFailed":
        await this.#startFailed(office, run, view.work, holdMessage(outcome.hold), outcome.hold);
        return;
      case "failed":
        await ender.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; the next session did not start: ${outcome.reason}`,
          endKind: OUTCOME_ENDS.crashed,
        });
        return;
    }
  }

  /**
   * A start failure (0008 section 7 and its 2026-10-14 amendment): the adapter is held and
   * `run.startFailed` raised. A worktree with work parks `worker-failed` and keeps everything;
   * otherwise the claim is released as DIPO-74 does and the story stays Ready.
   */
  async #startFailed(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef,
    detail: string,
    held: AdapterHold | null,
  ): Promise<void> {
    const hold =
      held ??
      this.#deps.holds?.hold(this.#deps.worker.id, [{ check: "start-failed", detail }]) ??
      null;
    const message = hold === null ? detail : holdMessage(hold);
    const claim = findClaim(office, run.runId);
    let holdsWork = true;
    try {
      holdsWork =
        claim === null
          ? false
          : ((await this.#deps.holdsWork?.(office.officeId, run, claim)) ?? true);
    } catch (error) {
      this.#deps.warn?.("reading the worktree's work after a start failure failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
    const story = run.story ?? run.runId;
    if (holdsWork || claim === null) {
      await this.#deps.ender().park(office, run, work, {
        intent: "stop",
        intentDetail: `${INTENT_TAGS.startFailed} ${detail}`,
        ops: [],
        reason: "worker-failed",
        detail: message,
        endKind: START_FAILED_END,
        notice: {
          level: "error",
          code: OUTCOME_NOTICES.startFailed,
          text: `${story}: the worker did not start (${detail}). Its worktree holds work, so dipo parked the story as worker-failed and kept worktree, branch and session.`,
        },
      });
      return;
    }
    const at = this.#deps.clock.now();
    office.immediate(() => {
      const id = recordIntent(
        office,
        run.runId,
        "stop",
        `${INTENT_TAGS.startFailed} ${detail}`,
        at,
      );
      markIntentSent(office, run.runId, id, at, null);
      resolveIntent(office, run.runId, id, "startFailed", at);
    });
    let released = `dipo removed the worktree and kept the branch ${claim.branch} for the next run`;
    try {
      if (this.#deps.release === undefined) {
        office.immediate(() =>
          releaseClaim(office, run.runId, { at, reason: START_FAILED_END, keepBranch: true }),
        );
        released = `dipo released the claim and kept the branch ${claim.branch}`;
      } else {
        await this.#deps.release(office.officeId, claim, START_FAILED_END);
      }
    } catch (error) {
      released = `releasing its claim failed (${messageOf(error)}), so the worktree ${claim.worktree} and the claim may still be there; check them`;
    }
    this.#write(office, () => [
      {
        type: "engine.notice",
        key: work.key,
        run: run.runId,
        delta: {
          level: "error",
          code: OUTCOME_NOTICES.startFailed,
          text: `${story} was not started: ${detail}. ${released}; the story stays Ready.`,
        },
      },
    ]);
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
   * no open wait and no other session after it.
   */
  async redispatch(officeId: OfficeId): Promise<number> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return 0;
    let count = 0;
    for (const run of activeRuns(office)) {
      if (run.kind !== "story") continue;
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
      if (agent === null || agent.ended_at === null || agent.end_reason !== "exited") continue;
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
      await this.onExit({
        view: {
          office: officeId,
          runId: run.runId,
          work,
          caps,
          startedAt: host?.started_at ?? run.startedAt,
          snapshot: null,
        },
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

  // ---- facts -----------------------------------------------------------------------------------

  /** The newest unresolved intent that explains a worker's exit. */
  #explaining(office: OfficeHandle, runId: RunId): StoredIntent | null {
    return (
      runIntents(office, runId)
        .filter((intent) => intent.resolvedAt === null && EXPLAINING.includes(intent.kind))
        .at(-1) ?? null
    );
  }

  #outcomeOf(intent: StoredIntent): string {
    if (intent.kind === "pause" && intentTag(intent.detail) === INTENT_TAGS.planLimit) {
      return "plan-limit";
    }
    if (intent.kind === "stop" && intentTag(intent.detail) === INTENT_TAGS.initRejected) {
      return "initRejected";
    }
    return UNTAGGED_OUTCOMES[intent.kind] ?? intent.kind;
  }

  #resolve(
    office: OfficeHandle,
    runId: RunId,
    intent: StoredIntent,
    outcome: string,
    at: number,
  ): void {
    office.immediate(() => resolveIntent(office, runId, intent.intentId, outcome, at));
  }

  /** The run's report feedback intents (the counter of AC #1). */
  #reportFeedbacks(office: OfficeHandle, runId: RunId): StoredIntent[] {
    return runIntents(office, runId).filter(
      (intent) =>
        intent.kind === "steer" && intentTag(intent.detail) === INTENT_TAGS.reportFeedback,
    );
  }

  /** True when an agent of the run other than `agent` ended for `reason`. */
  #endedAs(office: OfficeHandle, runId: string, agent: string, reason: string): boolean {
    return (
      office.get(
        `select 1 as found from agents where office_id = $office_id and run_id = $run
          and agent_id != $agent and end_reason = $reason`,
        { run: runId, agent, reason },
      ) !== null
    );
  }

  /** Records why the agent ended, replacing the ingestor's `exited` (a decision, so once). */
  #endAgent(office: OfficeHandle, agent: string, reason: string): void {
    office.immediate(() =>
      office.run(
        `update agents set end_reason = $reason
          where office_id = $office_id and agent_id = $agent
            and (end_reason is null or end_reason = 'exited')`,
        { reason, agent },
      ),
    );
  }

  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
  }
}

/** The one feedback turn "report in the schema" (0008 section 7, 0014 section 2). */
export function reportFeedbackText(why: string): string {
  return renderTemplate(FEEDBACK_TEMPLATES.report, { why });
}
