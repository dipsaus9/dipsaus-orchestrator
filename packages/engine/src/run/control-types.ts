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

import type { BackstopSnapshot } from "./backstop";
import type { IntentKind } from "./intents";
import type { RunAct, RunOutcomesPort, RunView } from "./outcome-types";
import type { ParkOutcome, ParkWriter } from "./park";
import type { StoredRun } from "./records";
import type { RunFinisher } from "./verify-commit";

/** The error of `work.stop` for a story with no active run (0005 section 4). */
export const STORY_NOT_RUNNING = "story.notRunning";

/** How often the caps are rechecked without new events (DIPO-15 M0 review): one minute. */
export const CAP_TICK_MS = 60_000;

/** The end kind of a run reconcile stopped or parked (DIPO-56). */
export const RECONCILED_END = "reconciled";

/** The park detail of a run whose host event file changed (0007 section 5, DIPO-57). */
export const EVENT_FILE_CHANGED = "event file changed";

/** The end kind of a run parked `interrupted` (DIPO-57). */
export const INTERRUPTED_END = "interrupted";

/** The park detail of `work.stop` without a note. */
export const STOPPED_DETAIL = "Stopped by the maintainer.";

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
    /** The office config; a `needs-permission` park's question reads its sandbox from it. */
    config?(office: OfficeId): OfficeConfig | undefined;
  };
  /** Question ids for the permission question of a `needs-permission` park (DIPO-75). */
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
}

/** What a started run is tracked with. */
export interface TrackedRun {
  readonly runId: RunId;
  readonly work: WorkRef;
  readonly caps: Caps;
  /** When the worker started (its host start), on the engine clock. */
  readonly startedAt: number;
  /** The backstop snapshot taken before the worker started (DIPO-49); null without one. */
  readonly snapshot?: BackstopSnapshot | null;
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
}

/** What ending a run does: the intent, the ops it sends and the park that follows. */
export interface RunEnding {
  readonly intent: IntentKind;
  /** The intent's detail; the park detail by default (DIPO-51 stores its tag here). */
  readonly intentDetail?: string;
  readonly ops: readonly HostOp[];
  readonly reason: ParkReason;
  /** Which of the reason's causes parks it (`PARK_CAUSES`, 0020 section 2). */
  readonly cause: string;
  readonly detail: string;
  readonly endKind: string;
  /** The report that led to the end, when a turn decided it. */
  readonly report?: WorkerReport | null;
  /** An `engine.notice` written before the park (DIPO-51). */
  readonly notice?: {
    readonly level: "info" | "warn" | "error";
    readonly code: string;
    readonly text: string;
  };
}

export type StopArgs = { readonly story: string; readonly note?: string | undefined };
export type StopResult = { run: RunId };

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
    snapshot: tracked.snapshot ?? null,
  };
}
