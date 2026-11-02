// The vocabulary of run control (DIPO-50, split out of `control.ts` by DIPO-128): its constants,
// ports, dependencies, the tracked run and the ending of a run. `control.ts` re-exports all of it.

import type {
  Clock,
  CommandName,
  IdSource,
  OfficeId,
  ParkReason,
  RunId,
  StoryKey,
  TimerHandle,
  WorkRef,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Caps, HostOp, SteerOp, WorkerReport } from "../workers/types";

import type { FiredCap } from "../records/caps";
import { STEER_UNREAD_NOTICE } from "../records/feedback-intents";
import type { IntentKind } from "../records/intents";
import type { LiveQuestions } from "../records/live-question";
import type { RunAct, RunOutcomesPort, RunView } from "./outcome-types";
import type { ParkOutcome, ParkWriter } from "./park";
import type { ParkStore } from "../records/park-state";
import type { StoredRun } from "../records/run-records";
import type { RunFinisher } from "./verify-commit";

/** The error of `work.steer` for a story with no worker and no park (0005). */
export const STORY_NOT_RUNNING = "story.notRunning";

/**
 * How long a stop waits for the stopped worker's exit (`stopAll`, and the reply of the
 * maintainer's park, DIPO-411): past the host's SIGKILL at 30 s.
 */
export const STOP_ALL_EXIT_WAIT_MS = 45_000;

/** How often the caps are rechecked without new events (DIPO-15 M0 review): one minute. */
export const CAP_TICK_MS = 60_000;

/** `agents.end_reason` of a session reconcile stopped (DIPO-56): its story left In Progress. */
export const RECONCILE_STOP_REASON = "reconciled";

/** The park detail of a run whose host event file changed (0007 section 5, DIPO-57). */
export const EVENT_FILE_CHANGED = "event file changed";

/** The park detail of a worker `daemon.stop { stopWorkers: true }` stopped (DIPO-315). */
export const DAEMON_STOPPED_DETAIL =
  "Parked by the maintainer: daemon.stop with stopWorkers stopped every worker before the daemon exited.";

/** `engine.notice` codes of run control. */
export const CONTROL_NOTICES = {
  notSent: "run.stopNotSent",
  feedbackNotSent: "run.feedbackNotSent",
  /** The worker read a maintainer steer (DIPO-412). */
  steerRead: "run.steerRead",
  /** A done turn waits for the turn a steer the worker has not read starts (DIPO-412). */
  steerAwaited: "run.steerAwaited",
  /** A run ended with a steer its worker never read (DIPO-412). */
  steerUnread: STEER_UNREAD_NOTICE,
} as const;

/** Sends host ops to a run's worker host. */
export interface RunSteering {
  send(
    office: OfficeHandle,
    runId: RunId,
    ops: readonly HostOp[],
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: string;
        /** The host's error code, when the host refused an op (for example `hook.unknown`). */
        readonly code?: string;
      }
  >;
}

export interface RunControlDeps {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
  readonly clock: Clock;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config?(office: OfficeId): OfficeConfig | undefined;
  };
  /** Question ids for the worker question an `ambiguous-spec` park asks (DIPO-159). */
  readonly ids?: IdSource;
  readonly writer: ParkWriter;
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode` (`WorkerPort.encode`). */
  readonly encode: (op: SteerOp) => HostOp[];
  /** True when the engine implements a command; parks offer only those. None by default. */
  readonly implemented?: (name: CommandName) => boolean;
  /** Writes pending `work.output` of a run before its state changes (0005 section 6). */
  readonly flushOutput?: (office: OfficeId, run: string) => void;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  /**
   * Reads the story again at its branch tip after the park commit or the In Review commit
   * (DIPO-56), so the story view and snapshots say Parked (with the F16 record) or In Review at
   * once. Both already emitted the story's state.
   */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
  /**
   * Hears a park written to resume by itself when the office's starts paused lifts (0020,
   * `StartsPaused.resumeLifted`): one that lands while the office is not paused (a run a plan limit
   * held before the upgrade, parked at load) resumes then.
   */
  readonly parkedToResume?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The cap tick; one minute by default. */
  readonly tickMs?: number;
  /**
   * Verify and commit (DIPO-49): the backstop after every turn and the In Review transition at
   * a `done` report. Without it a turn decides nothing beyond caps and blocked reports.
   */
  readonly finisher?: RunFinisher;
  /**
   * Worker outcomes (DIPO-51): turn problems, rejected inits, plan limits, classifier switches and
   * the decision at the worker's exit. Read when needed, so it can be built after run control.
   */
  readonly outcomes?: () => RunOutcomesPort | undefined;
  /**
   * The live wait of a blocked report's question (DIPO-272, 0021 section 11): read when a report
   * asks one. Without it, or when it does not take the question, the story parks with it.
   */
  readonly questions?: () => LiveQuestions | undefined;
}

/** What a started run is tracked with. */
export interface TrackedRun {
  readonly runId: RunId;
  readonly work: WorkRef;
  readonly caps: Caps;
  /** When the worker started (its host start), on the engine clock. */
  readonly startedAt: number;
}

export interface Tracked extends TrackedRun {
  readonly office: OfficeId;
  timer: TimerHandle | null;
  /** Set at the first decision; nothing else is decided for the run after it. */
  ending: Promise<ParkOutcome | null> | null;
  /** What `ending` carries out, in words, for a reply that waits on it (DIPO-411). */
  deciding: string | null;
  /** Resolves once the worker's exit was ingested (`onEnded`); the maintainer's park waits for it. */
  readonly exited: Promise<void>;
  readonly markExited: () => void;
  /** A turn problem's act whose intent could not be stored; the next cap tick tries it (DIPO-123). */
  unstored: RunAct | null;
  /** The after-turn work of the run, one turn at a time (DIPO-49). */
  turns: Promise<void>;
  /** The newest worker report, for the run summary. */
  lastReport: WorkerReport | null;
  /**
   * The cap crossed by a turn that carried a done report (DIPO-205): the run takes the done path,
   * and no cap ends it while verify and commit run.
   */
  capped: FiredCap | null;
  /**
   * A token crossing the model proxy's count made (DIPO-425), found at the minute tick or at a box
   * session's usage event with no done turn after it in the pass: the next pass or tick decides.
   * A done turn in that window takes the capped-done path, as on the crossing turn; else the cap.
   */
  waitingCrossing: FiredCap | null;
  /**
   * A done turn held back while the session has a steer it has not read (DIPO-412): the session
   * reads it after the turn's result and starts a new turn, whose report decides. While no steer
   * was read (`timer` runs) the held report is taken after all: `take` when the wait of
   * `STEER_READ_WAIT_MS` ends or the worker exits, and the capped-done path when a cap fires. Once
   * a read came, `timer` is null: the steer's turn decides, and an exit or a cap before its report
   * decides as for any turn in progress.
   */
  heldDone: {
    readonly report: WorkerReport;
    readonly take: () => void;
    timer: TimerHandle | null;
  } | null;
  /**
   * True while the finisher verifies and commits a done report (DIPO-412): a steer then waits for
   * the next session instead of reaching the idle one.
   */
  finishing: boolean;
}

/**
 * How long a done turn waits for the session to read a steer it was sent and has not read
 * (DIPO-412). Claude Code reads it right after the turn's result (1.6 s in the live probe).
 */
export const STEER_READ_WAIT_MS = 60_000;

/** What ending a run does: the intent, the ops it sends and the park that follows. */
export interface RunEnding {
  readonly intent: IntentKind;
  /** The intent's detail; the park detail by default (DIPO-51 stores its tag here). */
  readonly intentDetail?: string;
  readonly ops: readonly HostOp[];
  readonly reason: ParkReason;
  readonly detail: string;
  /** The report that led to the end, when a turn decided it. */
  readonly report?: WorkerReport | null;
  /**
   * The worker's question an `ambiguous-spec` park asks when no open question of the run carries
   * over to it (DIPO-159): the question of a blocked report with no TUI connected.
   */
  readonly question?: string;
  /**
   * True for the maintainer's `story.park` (DIPO-360): a park whose write to Backlog.md fails is
   * not recorded and the command fails, so the maintainer can send it again.
   */
  readonly mustWrite?: boolean;
  /** A plan limit's park, which resumes by itself when the office's starts paused lifts (0020). */
  readonly resumeOnLift?: boolean;
  /** An `engine.notice` written before the park (DIPO-51). */
  readonly notice?: {
    readonly level: "info" | "warn" | "error";
    readonly code: string;
    readonly text: string;
  };
}

/** `story.park` of a story with a run: the story and the maintainer's note (0020). */
export type ParkRunArgs = { readonly story: string; readonly note: string };
export type ParkRunResult = { run: RunId };

/** A notice reconcile puts on the office with what it did to a run (DIPO-56). */
export interface ReconcileNotice {
  readonly code: string;
  readonly text: string;
}

export function noticeEntry(run: StoredRun, notice: ReconcileNotice): NewEntry {
  return {
    type: "engine.notice",
    ...(run.key === null ? {} : { key: run.key }),
    run: run.runId,
    delta: { level: "warn", code: notice.code, text: notice.text },
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Ending = RunEnding;

/** Stops the cap tick of a tracked run, and drops a held done turn with its wait (DIPO-412). */
export function disarm(clock: Clock, tracked: Tracked): void {
  if (tracked.timer !== null) clock.clearTimeout(tracked.timer);
  tracked.timer = null;
  if (tracked.heldDone?.timer != null) clock.clearTimeout(tracked.heldDone.timer);
  tracked.heldDone = null;
}

/** A tracked run as worker outcomes see it. */
export function viewOf(tracked: Tracked): RunView {
  return {
    office: tracked.office,
    runId: tracked.runId,
    work: tracked.work,
    caps: tracked.caps,
    startedAt: tracked.startedAt,
  };
}
