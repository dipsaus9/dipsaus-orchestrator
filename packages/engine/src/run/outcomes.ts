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
//   A start the adapter refuses at its first line (`startRefused`, DIPO-108: a plugin the office
//   does not allow) stores the same intent but stops the worker at once, as a rejected init does
//   (stdin closed, SIGTERM now, SIGKILL after 30 s), and never parks for it.
// - `pause` `plan-limit {scope, resetsAt?, since}`: a rejected plan limit (a `rate_limit_event`
//   `rejected`, `credits_required`, or a 429 turn) closes stdin, writes the wait fact on the run,
//   raises the `plan-limit` signal with `work.observed plan-limit` (health `limited`), and never
//   parks: run and claim stay. `credits` also holds the adapter with a notice. The plan-limit
//   schedule (DIPO-61, `plan-limit.ts`) is told of the fact; it holds scheduling on the scope and
//   calls `resumeWait` after the reset, which resumes the session with "continue" and clears the
//   signal. An `allowed_warning` goes to the schedule too (`onPlanWarning`).
// - A classifier switch is recorded in the session's parser state and announced once per run and
//   model with `engine.notice` `run.modelSwitched`; it never parks.
//
// Each counter fires once per run and they are independent (maintainer decision Q5); they are
// read from facts (`run_intents`, `agents.end_reason`), so a restart keeps them. Every run that
// ends goes through `endRun` (a park, or the claim release of a start failure).

import type {
  Clock,
  OfficeId,
  RunId,
  StoryKey,
  WatchdogSignal,
  WorkRef,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import { finalizeAgentUsage } from "../ingest/usage";
import { parkAnswerMessage } from "../hooks/park-questions";
import { answeredParkQuestion, findQuestion } from "../hooks/questions";
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import { workRefOf, withWorkViews } from "../views/work";
import { type AdapterHold, holdMessage, type LaunchCheckFailure } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import type { Caps, HostOp, PlanLimitScope, SteerOp, TurnProblem } from "../workers/types";
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
  sendAsIntent,
  type StoredIntent,
} from "./intents";
import { START_FAILED_END } from "./launch";
import {
  openPark,
  PARK_NOTICES,
  type ParkOutcome,
  reopenParkedRun,
  type UnparkWriter,
} from "./park";
import { activeRuns, backstopSnapshotOf, capsStartedAt, findRun, type StoredRun } from "./records";
import type { NextSession } from "./resume";
import { activeSignals, raiseSignal } from "./signals";
import type { StoryGit } from "./story-git";

/** The tags DIPO-51 stores at the start of an intent's detail. */
export const INTENT_TAGS = {
  reportFeedback: "report-feedback",
  /** `answer` `park-resume <request JSON>`: an answer resuming a `needs-permission` park. */
  parkResume: "park-resume",
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
  interrupted: "interrupted",
} as const;

/** `agents.end_reason` of an agent whose host died without an exit file (DIPO-57). */
export const HOST_LOST_END = "host-lost";

/** Why a run lost its host, for the park and the resume (0006 decision 8, 0008 section 7). */
export const HOST_LOST_WHY = "the worker host died while the daemon was down";

/** Milliseconds from closing stdin to SIGTERM for a reassign (0008 section 6). */
export const REASSIGN_SIGTERM_AFTER_MS = 10_000;
/** Milliseconds to SIGKILL after a rejected init. */
export const INIT_REJECTED_SIGKILL_AFTER_MS = 30_000;

/**
 * The act of a start the adapter refused at its first line (`startRefused`, DIPO-108): stop the
 * worker at once, as for a rejected init, but as a `start-failed` stop, so its exit holds the
 * adapter and releases the claim (story Ready) instead of parking.
 */
export function startRefusedAct(reason: string): RunAct {
  return {
    intent: "stop",
    detail: `${INTENT_TAGS.startFailed} ${reason}`,
    ops: [
      { closeStdin: true },
      { signal: "SIGTERM" },
      { signal: "SIGKILL", afterMs: INIT_REJECTED_SIGKILL_AFTER_MS },
    ],
  };
}

/** The first message of a session resumed after a plan-limit reset (0008 section 7). */
export const PLAN_LIMIT_CONTINUE = "continue";

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

/**
 * The scope of a wait fact (0008 section 7): what the adapter named, `credits` for
 * `credits_required`, or `unknown` (treated as `session`).
 */
export type WaitScope = PlanLimitScope | "credits" | "unknown";

/** The wait fact of a plan-limit hold (0008 section 7, maintainer decision Q3a). */
export interface WaitFact {
  readonly scope: WaitScope;
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
  /** A turn problem's act: when its intent cannot be stored, the next cap tick tries it again (DIPO-123). */
  readonly retryAtTick?: boolean;
}

/** What worker outcomes ask of run control. */
export interface RunEnder {
  /** True while the run is tracked and nothing was decided for it. */
  live(runId: string): boolean;
  /** True while the run is tracked, decided or not (DIPO-57); its exit is decided there. */
  isTracked?(runId: string): boolean;
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

/** A rejected plan limit as run control hands it over. */
export interface PlanLimitHit {
  readonly credits: boolean;
  readonly resetsAt?: string;
  readonly scope?: PlanLimitScope;
}

/** An `allowed_warning` as run control hands it over (DIPO-61). */
export interface PlanLimitWarning {
  readonly resetsAt?: string;
  readonly scope?: PlanLimitScope;
}

/**
 * The plan-limit schedule (DIPO-61, `plan-limit.ts`): told of every wait fact written and every
 * `allowed_warning`, it holds scheduling on the scope and resumes the run after the reset.
 */
export interface PlanLimitWaits {
  waiting(office: OfficeId, runId: RunId, fact: WaitFact): void;
  warned(office: OfficeId, warning: PlanLimitWarning): void;
}

/** What run control calls. */
export interface RunOutcomesPort {
  onTurnProblem(view: RunView, problem: TurnProblem): Promise<void>;
  onPlanLimit(view: RunView, limit: PlanLimitHit): void;
  /** An `allowed_warning`: new runs on the scope wait for the reset (DIPO-61). */
  onPlanWarning?(view: RunView, warning: PlanLimitWarning): void;
  onModelSwitched(view: RunView, model: string): void;
  /** A turn arrived: an open report feedback is answered. */
  answered(view: RunView): void;
  onExit(exit: ExitContext): Promise<void>;
  /** The run's host died without an exit file or an exit line (DIPO-57). */
  onHostLost?(lost: HostLostContext): Promise<void>;
}

/** A host found dead without `exit.json` after a restart, as run control hands it over. */
export interface HostLostContext {
  readonly view: RunView;
  readonly agent: string;
  /** A decision on the run under way (from its caught-up turns), or null. */
  readonly ending: Promise<unknown> | null;
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
  /** The plan-limit schedule (DIPO-61); read when needed, since it is built after this. */
  readonly waits?: () => PlanLimitWaits | undefined;
  /** Lifts a park on the story branch (DIPO-75); without it no parked run resumes. */
  readonly unpark?: UnparkWriter;
  /** Reads the story again at its branch tip after the park was lifted there (DIPO-75). */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** What resuming a parked run asks for (DIPO-75, `RunOutcomes.resumePark`). */
export interface ResumeParkRequest {
  /** The open park the answer belongs to. */
  readonly parkId: number;
  /** The park's open permission question being answered. */
  readonly question: string;
  readonly decision: "allow" | "deny";
  /** The maintainer's text with the decision; empty for none. */
  readonly text: string;
}

/** What resuming a parked run did (DIPO-75). */
export type ResumeParkOutcome =
  /**
   * The run is active again and the answer recorded; from `resumePark` its next session is
   * starting in the background (a failed start parks or releases the story with its notice).
   */
  | { readonly kind: "started" }
  /** The park was lifted but the next session did not start; the story parked or released again. */
  | { readonly kind: "notStarted" }
  /** The run has no open park `parkId`, or it was not this run's. */
  | { readonly kind: "notParked" }
  /** The parked worker's exit is not ingested yet (retryable). */
  | { readonly kind: "busy" }
  /** Nothing changed: the park could not be lifted. */
  | { readonly kind: "failed"; readonly reason: string };

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
  /** The exits being decided now, as run and agent; a restart step leaves their runs alone. */
  readonly #deciding = new Set<string>();
  /** Sessions of resumed parks starting after their answer was replied to (DIPO-75). */
  readonly #inflight = new Set<Promise<unknown>>();

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
          retryAtTick: true,
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
        ender.act(view.runId, {
          intent: "reassign",
          detail: INTENT_TAGS.contextFull,
          ops: close,
          retryAtTick: true,
        });
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
          retryAtTick: true,
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
    await sendAsIntent(office, this.#deps.steering, view.runId, {
      kind: "steer",
      detail: `${INTENT_TAGS.reportFeedback} ${view.work.agent} ${why}`,
      ops: this.#deps.encode({ kind: "steer", text: reportFeedbackText(why) }),
      clock: this.#deps.clock,
    }).done;
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
    this.#hold(office, view.runId, view.work, fact);
  }

  onPlanWarning(view: RunView, warning: PlanLimitWarning): void {
    this.#deps.waits?.()?.warned(view.office, warning);
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
    // The schedule holds the scope and resumes the run after the reset (DIPO-61).
    this.#deps.waits?.()?.waiting(office.officeId, runId, fact);
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
    const key = `${exit.view.runId} ${exit.agent}`;
    if (this.#deciding.has(key)) return;
    this.#deciding.add(key);
    try {
      await this.#decideExit(exit);
    } finally {
      this.#deciding.delete(key);
    }
  }

  /** Resolves once every session start of a resumed park this started has finished (DIPO-75). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** True while an exit or a lost host of the run is being decided here (DIPO-57). */
  busy(runId: string): boolean {
    return [...this.#deciding].some((key) => key.startsWith(`${runId} `));
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
    if (this.#deciding.has(key)) return;
    this.#deciding.add(key);
    try {
      await lost.ending?.catch(() => undefined);
      const { view, agent } = lost;
      const office = this.#deps.offices.get(view.office);
      if (office === undefined) return;
      const intent = this.#explaining(office, view.runId);
      const at = this.#deps.clock.now();
      // The agent ends with the signal in one transaction: a restart before the decision below
      // finds `host-lost` and decides it again.
      this.#write(office, () => {
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
        if (intent !== null) this.#resolve(office, view.runId, intent, this.#outcomeOf(intent), at);
        return;
      }
      if (intent !== null) {
        await this.#byIntent(office, run, view, agent, intent);
        return;
      }
      await this.#hostLost(office, run, view, agent);
    } finally {
      this.#deciding.delete(key);
    }
  }

  /** The decision on an agent that ended `host-lost`: one resume, else park `interrupted`. */
  async #hostLost(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    agent: string,
  ): Promise<void> {
    const refused = this.#noRetry(office, view, agent);
    if (refused !== null) {
      const suffix = refused === "" ? "; dipo cannot start another session of the run" : refused;
      await this.#park(office, run, view.work, {
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
    await this.#next(office, run, view, {
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
    const intent = this.#explaining(office, view.runId);
    if (run.endedAt !== null) {
      if (intent !== null) this.#resolve(office, view.runId, intent, this.#outcomeOf(intent), at);
      return;
    }
    if (intent !== null) {
      await this.#byIntent(office, run, view, agent, intent);
      return;
    }
    // This worker exited before it answered its report feedback: resume with it. The feedback
    // is resolved only once the next session started, so a restart in between resumes again.
    const feedback = this.#reportFeedbacks(office, view.runId).find(
      (row) => row.resolvedAt === null && feedbackOf(row.detail).agent === agent,
    );
    if (feedback !== undefined) {
      const started = await this.#next(office, run, view, {
        mode: "resume",
        why: "the worker exited before it answered the report feedback",
        message: reportFeedbackText(feedbackOf(feedback.detail).why),
      });
      if (started) this.#resolve(office, view.runId, feedback, "resumed", this.#deps.clock.now());
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
        this.#endAgentIn(office, agent, "prompt-too-long");
      });
      await this.#next(office, run, view, {
        mode: "handoff",
        why: "a full context (prompt_too_long)",
      });
      return;
    }
    if (intent.kind === "reassign" && tag === INTENT_TAGS.error) {
      office.immediate(() => {
        resolveIntent(office, view.runId, intent.intentId, "reassigned", at);
        this.#endAgentIn(office, agent, "crashed");
      });
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
    const park = (ending: Omit<RunEnding, "ops"> & { readonly ops?: readonly HostOp[] }) =>
      this.#park(office, run, view.work, { ops: [], ...ending });
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
          const started = await this.#next(office, run, view, {
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
    const refused = this.#noRetry(office, view, agent);
    if (refused !== null) {
      await this.#park(office, run, view.work, {
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
    if (
      this.#endedAs(office, view.runId, agent, "crashed") ||
      this.#endedAs(office, view.runId, agent, HOST_LOST_END)
    ) {
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
      /** Only a resume will do; a session that cannot be resumed parks `interrupted` (DIPO-57). */
      readonly requireResume?: boolean;
      readonly clear?: readonly WatchdogSignal[];
    },
  ): Promise<boolean> {
    const resumer = this.#deps.resumer;
    if (resumer === undefined) {
      await this.#park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${request.why}; dipo cannot start another session of the run`,
        endKind: OUTCOME_ENDS.crashed,
      });
      return false;
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
        ...(request.requireResume === true ? { requireResume: true } : {}),
        ...(request.clear === undefined ? {} : { clear: request.clear }),
        caps: view.caps,
        startedAt: view.startedAt,
        snapshot: view.snapshot,
      });
    } catch (error) {
      outcome = { kind: "failed" as const, reason: messageOf(error) };
    }
    switch (outcome.kind) {
      case "started":
        return true;
      case "startFailed":
        await this.#startFailed(office, run, view.work, holdMessage(outcome.hold), outcome.hold);
        return false;
      case "failed":
        await this.#park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; the next session did not start: ${outcome.reason}`,
          endKind: OUTCOME_ENDS.crashed,
        });
        return false;
      case "hostAlive":
        // Retryable: `work.resume` starts the session once the old host has ended.
        await this.#park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; ${outcome.code}: the earlier worker host of the run (pid ${outcome.pid}) still runs, so no new session starts`,
          endKind: OUTCOME_ENDS.crashed,
        });
        return false;
      case "notResumed":
        await this.#park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "interrupted",
          detail: `${request.why}; its session cannot be resumed: ${outcome.reason}`,
          endKind: OUTCOME_ENDS.interrupted,
        });
        return false;
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
      await this.#park(office, run, work, {
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
   * no open wait and no other session after it. A newest agent that ended `crashed` or
   * `prompt-too-long` had its decision recorded but its next session never started: that session
   * starts now (a resume after a crash, a handoff after a full context).
   */
  async redispatch(officeId: OfficeId): Promise<number> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return 0;
    // Park resumes a restart interrupted (DIPO-75) first: their runs are skipped below.
    let count = await this.#recoverParkResumes(officeId, office);
    for (const run of activeRuns(office)) {
      // A run decided here, or followed by run control (re-attached, DIPO-57), is decided there.
      const tracked = this.#deps.ender().isTracked?.(run.runId) ?? false;
      if (run.kind !== "story" || this.busy(run.runId) || tracked) continue;
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
        this.#deciding.add(key);
        try {
          if (decided === HOST_LOST_END) {
            await this.#hostLost(office, run, view, agent.agent_id);
            continue;
          }
          await this.#next(
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
        } finally {
          this.#deciding.delete(key);
        }
        continue;
      }
      await this.onExit({
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

  /**
   * Resumes a run held by a plan limit (DIPO-61, 0008 section 7): its native session continues
   * with "continue" (a handoff when it cannot be resumed), and the `plan-limit` signal ends when
   * the new session is recorded. `notHeld` when the run has no open wait or has ended, `busy`
   * while the held worker has not exited yet. A next session that cannot start parks or releases
   * the story as after a crash.
   */
  async resumeWait(
    officeId: OfficeId,
    runId: RunId,
    why: string,
  ): Promise<"started" | "failed" | "notHeld" | "busy"> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return "notHeld";
    const run = findRun(office, runId);
    if (run === null || run.endedAt !== null || openWait(office, runId) === null) return "notHeld";
    const key = `${runId} plan-limit`;
    if ([...this.#deciding].some((deciding) => deciding.startsWith(`${runId} `))) return "busy";
    const latest = office.get<{ ended_at: number | null }>(
      `select ended_at from agents where office_id = $office_id and run_id = $run
        order by started_at desc, rowid desc limit 1`,
      { run: runId },
    );
    if (latest !== null && latest.ended_at === null) return "busy";
    const view = this.#viewOf(officeId, office, run);
    if (view === null) return "notHeld";
    this.#deciding.add(key);
    try {
      // The pause explained the held worker's exit; one left open (an exit a restart did not
      // decide) must not explain the next session's exit.
      const at = this.#deps.clock.now();
      for (const intent of runIntents(office, runId)) {
        if (intent.resolvedAt !== null || intent.kind !== "pause") continue;
        if (intentTag(intent.detail) !== INTENT_TAGS.planLimit) continue;
        this.#resolve(office, runId, intent, "plan-limit", at);
      }
      const started = await this.#next(office, run, view, {
        mode: "resume",
        why,
        message: PLAN_LIMIT_CONTINUE,
        clear: ["plan-limit"],
      });
      return started ? "started" : "failed";
    } finally {
      this.#deciding.delete(key);
    }
  }

  /**
   * Resumes the run of a story parked `needs-permission` after the maintainer answered the park's
   * question (DIPO-75; 0008 sections 5 and 8). An `answer` intent tagged `park-resume` with the
   * request is stored first. The park is lifted on the story branch (the F16 record removed, the
   * status back to the park's `from`, committed and pushed), then one transaction resolves the
   * park `resume`, reopens the run (`story.state` leaves Parked), records the answer, so an allow
   * is in place before the session's first call, and marks the intent sent. The run's next
   * session starts on the same run: `--resume` of the native session when `canResume` holds,
   * else a handoff, with the answer's message first and what remains of the run's caps; the time
   * the story stood parked does not count (`parked_ms`). The intent is then resolved. A session
   * that does not start parks or releases the story as after a crash. A restart before the
   * intent is resolved finishes the resume (`redispatch`).
   */
  async resumePark(
    officeId: OfficeId,
    runId: RunId,
    request: ResumeParkRequest,
  ): Promise<ResumeParkOutcome> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return { kind: "notParked" };
    const run = findRun(office, runId);
    if (run === null || run.kind !== "story" || run.key === null || run.endedAt === null) {
      return { kind: "notParked" };
    }
    const park = openPark(office, run.key);
    if (park === null || park.parkId !== request.parkId || park.runId !== runId) {
      return { kind: "notParked" };
    }
    if ([...this.#deciding].some((deciding) => deciding.startsWith(`${runId} `))) {
      return { kind: "busy" };
    }
    const latest = office.get<{ ended_at: number | null }>(
      `select ended_at from agents where office_id = $office_id and run_id = $run
        order by started_at desc, rowid desc limit 1`,
      { run: runId },
    );
    if (latest !== null && latest.ended_at === null) return { kind: "busy" };
    if (
      this.#deps.caps?.(officeId, run) == null ||
      workRefOf(office, runId) === null ||
      this.#deps.unpark === undefined
    ) {
      return { kind: "failed", reason: `dipo cannot resume ${runId} in this office` };
    }
    const question = findQuestion(office, request.question);
    if (question === null || question.closedAt !== null || question.parkId !== park.parkId) {
      return { kind: "notParked" };
    }
    const key = `${runId} park-resume`;
    this.#deciding.add(key);
    try {
      // Stored before anything changes, so a restart in between finishes the resume.
      const intentId = office.immediate(() =>
        recordIntent(
          office,
          runId,
          "answer",
          `${INTENT_TAGS.parkResume} ${JSON.stringify({ ...request, agent: workRefOf(office, runId)?.agent ?? null })}`,
          this.#deps.clock.now(),
        ),
      );
      return await this.#finishParkResume(office, run, request, intentId, false, true);
    } finally {
      this.#deciding.delete(key);
    }
  }

  /**
   * The steps of a park resume after its intent is stored: unless `reopened`, the park is lifted
   * on the branch (idempotent: a lift already written commits nothing), then one transaction
   * resolves the park, reopens the run, records the answer and marks the intent sent; then the
   * next session starts and the intent is resolved with how it went.
   */
  async #finishParkResume(
    office: OfficeHandle,
    run: StoredRun,
    request: ResumeParkRequest,
    intentId: number,
    reopened: boolean,
    /** Start the next session after returning (the command); wait for it otherwise (recovery). */
    background: boolean,
  ): Promise<ResumeParkOutcome> {
    const officeId = office.officeId as OfficeId;
    const runId = run.runId;
    const resolve = (outcome: string) =>
      office.immediate(() =>
        resolveIntent(office, runId, intentId, outcome, this.#deps.clock.now()),
      );
    const caps = this.#deps.caps?.(officeId, run) ?? null;
    const work = workRefOf(office, runId);
    const question = findQuestion(office, request.question);
    const unpark = this.#deps.unpark;
    if (
      caps === null ||
      work === null ||
      question?.tool == null ||
      question.input === null ||
      run.story === null ||
      run.branch === null ||
      run.worktree === null ||
      run.key === null ||
      (!reopened && unpark === undefined)
    ) {
      resolve("failed");
      return { kind: "failed", reason: `dipo cannot resume ${runId} in this office` };
    }
    if (!reopened && unpark !== undefined) {
      const park = openPark(office, run.key);
      if (park === null || park.parkId !== request.parkId) {
        resolve("notParked");
        return { kind: "notParked" };
      }
      const to = park.from === "In Review" ? "In Review" : "In Progress";
      let lifted;
      try {
        lifted = await unpark.lift(officeId, {
          story: run.story,
          branch: run.branch,
          worktree: run.worktree,
          to,
        });
      } catch (error) {
        resolve("failed");
        return { kind: "failed", reason: `lifting the park failed: ${messageOf(error)}` };
      }
      const at = this.#deps.clock.now();
      const pushNotice: NewEntry[] =
        lifted.pushError === null
          ? []
          : [
              {
                type: "engine.notice",
                key: work.key,
                run: runId,
                delta: {
                  level: "warn",
                  code: PARK_NOTICES.pushFailed,
                  text: `${run.story}: the park was lifted, but ${lifted.pushError}; the change is on the local branch only until a later push succeeds.`,
                },
              },
            ];
      // The park resolved, the run active again, the answer recorded (an allow is in place before
      // the session's first call) and the intent sent: one transaction.
      this.#write(office, () => {
        const reopenedEntries = reopenParkedRun(office, park, run, to, at);
        const answered = answeredParkQuestion(
          office,
          request.question,
          request.decision,
          request.text,
          at,
        );
        markIntentSent(office, runId, intentId, at, null);
        return [...reopenedEntries, ...answered, ...pushNotice];
      });
      await this.#deps.refreshStory?.(officeId, work.key).catch((error: unknown) => {
        this.#deps.warn?.("reading the resumed story again failed", {
          run: runId,
          reason: messageOf(error),
        });
      });
    }
    // The run's caps count the time it worked, not the time it stood parked (`parked_ms`).
    const fresh = findRun(office, runId) ?? run;
    const host = office.get<{ started_at: number | null }>(
      `select min(started_at) as started_at from worker_hosts
        where office_id = $office_id and run_id = $run`,
      { run: runId },
    );
    const permission = { tool: question.tool, action: question.input };
    const startSession = async (): Promise<boolean> => {
      const started = await this.#next(
        office,
        fresh,
        {
          office: officeId,
          runId,
          work,
          caps,
          startedAt: capsStartedAt(fresh, host?.started_at),
          snapshot: null,
        },
        {
          mode: "resume",
          why: `the maintainer's ${request.decision === "allow" ? "allow once" : "deny"} of ${permission.tool}: ${permission.action}`,
          message: parkAnswerMessage(permission, request.decision, request.text),
        },
      );
      resolve(started ? "resumed" : "notStarted");
      return started;
    };
    if (!background) {
      return (await startSession()) ? { kind: "started" } : { kind: "notStarted" };
    }
    // The answer's reply does not wait for the worker host (it may take many seconds): the
    // session starts after it. A start that fails parks or releases the story with its notice, as
    // after a crash; a restart before it is done finishes it from the intent.
    const key = `${runId} park-session`;
    this.#deciding.add(key);
    const job = startSession()
      .catch((error: unknown) => {
        this.#deps.warn?.("starting the session of a resumed park failed", {
          run: runId,
          reason: messageOf(error),
        });
        return false;
      })
      .finally(() => this.#deciding.delete(key));
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
    return { kind: "started" };
  }

  /**
   * After a restart (DIPO-75): a park resume whose intent was stored but not resolved is finished.
   * Not yet sent (the daemon stopped before the reopen): the park is lifted again, which commits
   * nothing when it was already lifted, and the run reopened, while its park and question are still
   * open; otherwise the intent is dropped and the question stays answerable. Sent (reopened, the
   * answer recorded) but no session after it: the next session starts.
   */
  async #recoverParkResumes(officeId: OfficeId, office: OfficeHandle): Promise<number> {
    const rows = office.all<{ run_id: string; intent_id: number; detail: string; state: string }>(
      `select run_id, intent_id, detail, state from run_intents
        where office_id = $office_id and kind = 'answer' and resolved_at is null
          and detail like $tag order by created_at, intent_id`,
      { tag: `${INTENT_TAGS.parkResume} %` },
    );
    let count = 0;
    for (const row of rows) {
      const runId = row.run_id as RunId;
      const run = findRun(office, runId);
      const resolve = (outcome: string) =>
        office.immediate(() =>
          resolveIntent(office, runId, row.intent_id, outcome, this.#deps.clock.now()),
        );
      let request: ResumeParkRequest;
      try {
        request = JSON.parse(intentRest(row.detail)) as ResumeParkRequest;
      } catch {
        resolve("failed");
        continue;
      }
      if (run === null || run.key === null || this.busy(runId)) continue;
      const key = `${runId} park-resume`;
      this.#deciding.add(key);
      try {
        if (row.state === "pending") {
          const park = openPark(office, run.key);
          const question = findQuestion(office, request.question);
          if (
            run.endedAt === null ||
            park?.parkId !== request.parkId ||
            question === null ||
            question.closedAt !== null
          ) {
            resolve("abandoned");
            continue;
          }
          await this.#finishParkResume(office, run, request, row.intent_id, false, false);
          count += 1;
          continue;
        }
        // Reopened: start the session unless one started after the intent (a newer agent than the
        // parked one it names).
        const latest = office.get<{ agent_id: string }>(
          `select agent_id from agents where office_id = $office_id and run_id = $run
            order by started_at desc, rowid desc limit 1`,
          { run: runId },
        );
        const parkedAgent = (request as ResumeParkRequest & { agent?: string | null }).agent;
        const newer = latest !== null && parkedAgent != null && latest.agent_id !== parkedAgent;
        if (run.endedAt !== null || newer) {
          resolve("resumed");
          continue;
        }
        await this.#finishParkResume(office, run, request, row.intent_id, true, false);
        count += 1;
      } finally {
        this.#deciding.delete(key);
      }
    }
    return count;
  }

  /** The view of an active run that is not tracked, as after a restart; null without one. */
  #viewOf(officeId: OfficeId, office: OfficeHandle, run: StoredRun): RunView | null {
    const work = workRefOf(office, run.runId);
    const caps = this.#deps.caps?.(officeId, run) ?? null;
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
  async #park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef,
    ending: RunEnding,
  ): Promise<ParkOutcome> {
    const parked = await this.#deps.ender().park(office, run, work, ending);
    const intent = this.#explaining(office, run.runId);
    if (intent !== null) {
      this.#resolve(office, run.runId, intent, this.#outcomeOf(intent), this.#deps.clock.now());
    }
    return parked;
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
    office.immediate(() => this.#endAgentIn(office, agent, reason));
  }

  /** `#endAgent` inside the caller's transaction. */
  #endAgentIn(office: OfficeHandle, agent: string, reason: string): void {
    office.run(
      `update agents set end_reason = $reason
        where office_id = $office_id and agent_id = $agent
          and (end_reason is null or end_reason = 'exited')`,
      { reason, agent },
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

/** The agent a report feedback was sent to and why, from its intent detail. */
function feedbackOf(detail: string): { readonly agent: string; readonly why: string } {
  const rest = intentRest(detail);
  const space = rest.indexOf(" ");
  return space === -1
    ? { agent: rest, why: "" }
    : { agent: rest.slice(0, space), why: rest.slice(space + 1) };
}

/** The one feedback turn "report in the schema" (0008 section 7, 0014 section 2). */
export function reportFeedbackText(why: string): string {
  return renderTemplate(FEEDBACK_TEMPLATES.report, { why });
}
