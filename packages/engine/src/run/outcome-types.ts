// The shared vocabulary of worker outcomes (DIPO-51, split out of `outcomes.ts` by DIPO-128): the
// intent tags, end kinds, notices and the ports between run control and the
// outcome units. `outcomes.ts` re-exports all of it.

import type { Clock, OfficeId, RunId, StoryKey, WorkRef } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import type { PriceBook } from "../pricing/estimate";
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import { type AdapterHold, type LaunchCheckFailure } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import type { Caps, HostOp, ReviewReport, SteerOp, TurnProblem } from "../workers/types";
import type { ClaimRecord } from "../worktree/records";

import type { BackstopSnapshot } from "./backstop";
import type { RunEnding, RunSteering } from "./control-types";
import type { IntentKind } from "./intents";
import { type ParkOutcome, type UnparkWriter } from "./park";
import type { StoredRun } from "./records";
import type { NextSession } from "./resume";
import type { PlanLimitPause, StartsPausedState } from "./starts-paused";
import type { StoryGit } from "./story-git";

/** The tags DIPO-51 stores at the start of an intent's detail. */
export const INTENT_TAGS = {
  contextFull: "new-session:context-full",
  error: "new-session:error",
  initRejected: "init-rejected",
  startFailed: "start-failed",
} as const;

/** `engine.notice` codes of worker outcomes. */
export const OUTCOME_NOTICES = {
  initRejected: "run.initRejected",
  modelSwitched: "run.modelSwitched",
  startFailed: "run.startFailed",
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
  /** A plan limit stopped the session: the story parks `worker-failed` until starts resume. */
  planLimit: "plan-limit",
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
export function intentRest(detail: string): string {
  const space = detail.indexOf(" ");
  return space === -1 ? "" : detail.slice(space + 1);
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
}

/** The office's starts paused as worker outcomes and the review rounds tell it of a plan limit. */
export interface PlanLimitPauses {
  pausePlanLimit(office: OfficeId, pause: PlanLimitPause): void;
}

/**
 * The office's starts paused as worker outcomes use it (0020): a plan limit pauses it, a run's
 * next session asks it first, and a load that parked runs a plan limit held resumes them.
 */
export interface StartsPausedPort extends PlanLimitPauses {
  state(office: OfficeId): StartsPausedState | null;
  resumeLifted(office: OfficeId): void;
}

/**
 * The park of a session that met a plan limit (0020): `worker-failed` with the limit's detail,
 * resumed by itself when the office's starts paused lifts.
 */
export function planLimitEnding(pause: PlanLimitPause, ops: readonly HostOp[]): RunEnding {
  return {
    intent: "park",
    ops,
    reason: "worker-failed",
    detail: pause.detail,
    endKind: OUTCOME_ENDS.planLimit,
    resumeOnLift: true,
  };
}

/** What run control calls. */
export interface RunOutcomesPort {
  onTurnProblem(view: RunView, problem: TurnProblem): Promise<void>;
  onPlanLimit(view: RunView, limit: PlanLimitHit): void;
  onModelSwitched(view: RunView, model: string): void;
  /** A turn arrived: an open report feedback is answered. */
  answered(view: RunView): void;
  /**
   * A reviewer session's turn carried a report valid against the review schema (0019 section 5),
   * after the backstop let the turn continue (DIPO-219).
   */
  onReview?(view: RunView, report: ReviewReport): Promise<void>;
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

/**
 * The ending of a rejected init (0008 sections 2 and 7); `cause` is the session's, the
 * reviewer's `review` for a reviewer session (0019 section 4).
 */
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
  /** The worker port's id, pure `result` and transcript parser. */
  readonly worker: Pick<WorkerPort, "id" | "result" | "readTranscript">;
  /**
   * The pricing catalog (`StateDatabase.pricing`), to estimate the usage read from a transcript
   * (DIPO-134); without it that usage keeps no estimated cost.
   */
  readonly pricing?: () => PriceBook | null;
  /** Run control; read when needed, since it is built with this as its outcomes. */
  readonly ender: () => RunEnder;
  /** Starts the run's next session; without it every crash parks `worker-failed`. */
  readonly resumer?: NextSession;
  /** DIPO-43's adapter hold, set for start failures: the office's starts paused (0020). */
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
  /** The office's starts paused (0020), which a plan limit pauses; read when needed. */
  readonly startsPaused?: () => StartsPausedPort | undefined;
  /** Lifts a park on the story branch (DIPO-75); without it no parked run resumes. */
  readonly unpark?: UnparkWriter;
  /** Finishes the park resumes a restart interrupted (`Resumption`); the number it finished. */
  readonly recoverParks?: (office: OfficeId, handle: OfficeHandle) => Promise<number> | number;
  /** Reads the story again at its branch tip after the park was lifted there (DIPO-75). */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one feedback turn "report in the schema" (0008 section 7, 0014 section 2). */
export function reportFeedbackText(why: string): string {
  return renderTemplate(FEEDBACK_TEMPLATES.report, { why });
}
