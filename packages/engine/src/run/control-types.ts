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

import type { FiredCap } from "./caps";
import type { IntentKind } from "./intents";
import type { LiveQuestions } from "./live-question";
import type { RunAct, RunOutcomesPort, RunView } from "./outcome-types";
import type { ParkOutcome, ParkWriter } from "./park";
import type { StoredRun } from "./records";
import type { RunFinisher } from "./verify-commit";

/** The error of `work.steer` for a story with no worker and no park (0005). */
export const STORY_NOT_RUNNING = "story.notRunning";

/** How often the caps are rechecked without new events (DIPO-15 M0 review): one minute. */
export const CAP_TICK_MS = 60_000;

/** The end kind of a run reconcile stopped or parked (DIPO-56). */
export const RECONCILED_END = "reconciled";

/** The park detail of a run whose host event file changed (0007 section 5, DIPO-57). */
export const EVENT_FILE_CHANGED = "event file changed";

/** The end kind of a run whose worker failed or was lost (DIPO-57). */
export const INTERRUPTED_END = "interrupted";

/** The park detail of a worker `daemon.stop { stopWorkers: true }` stopped (DIPO-315). */
export const DAEMON_STOPPED_DETAIL =
  "Parked by the maintainer: daemon.stop with stopWorkers stopped every worker before the daemon exited.";

/** `engine.notice` codes of run control. */
export const CONTROL_NOTICES = {
  notSent: "run.stopNotSent",
  stopSignalled: "run.stopSignalled",
  feedbackNotSent: "run.feedbackNotSent",
} as const;

/** Sends host ops to a run's worker host. */
export interface RunSteering {
  send(
    office: OfficeHandle,
    runId: RunId,
    ops: readonly HostOp[],
  ): Promise<
    | {
        readonly ok: true;
        /** `signal` when a verified SIGTERM stopped a follow-only host instead (DIPO-93). */
        readonly via?: "socket" | "signal";
      }
    | {
        readonly ok: false;
        readonly reason: string;
        /** The host's error code, when the host refused an op (for example `hook.unknown`). */
        readonly code?: string;
      }
  >;
}

export interface RunControlDeps {
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
}

/** What ending a run does: the intent, the ops it sends and the park that follows. */
export interface RunEnding {
  readonly intent: IntentKind;
  /** The intent's detail; the park detail by default (DIPO-51 stores its tag here). */
  readonly intentDetail?: string;
  readonly ops: readonly HostOp[];
  readonly reason: ParkReason;
  readonly detail: string;
  readonly endKind: string;
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

/** Stops the cap tick of a tracked run. */
export function disarm(clock: Clock, tracked: Tracked): void {
  if (tracked.timer !== null) clock.clearTimeout(tracked.timer);
  tracked.timer = null;
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
