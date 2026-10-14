// Run control (DIPO-50; 0008 sections 6 and 7, 0005 section 4): the engine's caps, the parks a
// worker's report asks for and `work.stop`.
//
// - Caps. Each started run is tracked with its tier's caps and the time its worker started. After
//   every `usage` and `turn` event, as of that event inside its ingestion pass (`onEventApplied`),
//   and on a 1-minute tick of the injected clock (so the time cap fires without new events), the
//   run's budget tokens, summed turns and wall-clock minutes are compared with the caps
//   (`caps.ts`). After the pass commits, the engine acts at the first event that decides. At
//   100% of one it records a `cap` intent, sends the stop sequence and parks the story
//   `budget-exceeded` naming the cap and the total at the crossing. A turn that ended at the adapter's own turn cap (the CLI backstop, `error_max_turns`)
//   does the same at that turn, so a later turn of a queued message never overrides it.
// - Reports. A turn whose report is `blocked` parks the story: `needs-permission` with the tool and
//   action as detail when it carries `needsPermission` (a call `--permission-prompts none` denied,
//   0008 section 5), else `ambiguous-spec` with the question. The engine records a `park` intent
//   and closes the worker's stdin; worktree, branch and session are kept. Waiting for an answer
//   before the park is M1 (DIPO-15, decision D2).
// - `work.stop { story, note? }`. A story with no active run fails `story.notRunning`. Otherwise
//   the engine records a `stop` intent, sends the stop sequence through the host (the adapter's
//   `encode`: a now-priority message, stdin closed, SIGTERM after 10 s, SIGKILL after 30 s) and
//   parks the story `stopped`; branch and worktree are kept.
//
// Every op is stored as a pending intent before it is sent (`intents.ts`), and when the worker
// exits the intent that explains the exit is resolved with its outcome. After the first decision
// on a run nothing else is decided for it: later events of the same or a later pass are ignored.
//
// Worker outcomes (DIPO-51, `outcomes.ts`): a rejected init, a plan limit, a classifier switch
// and a turn's problem (no valid report, a full context, an execution error, a start failure) are
// handed to the run's outcomes, and so is the worker's exit once the turns before it are done.
// Run control is their `RunEnder`: it records the intent, sends the ops and parks.

import {
  type Clock,
  type CommandName,
  type OfficeId,
  type ParkReason,
  type RunId,
  type StoryKey,
  type TimerHandle,
  type WorkRef,
  workStop,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit, IngestHooks } from "../ingest/ingestor";
import { withWorkViews, workRefOf } from "../views/work";
import type {
  Caps,
  HostOp,
  SteerOp,
  TurnProblem,
  WorkerEvent,
  WorkerReport,
} from "../workers/types";

import type { BackstopSnapshot } from "./backstop";

import { type CapName, type FiredCap, firedCap, runTotals } from "./caps";
import {
  type IntentKind,
  markIntentSent,
  outcomeOfIntent,
  recordIntent,
  resolveIntent,
} from "./intents";
import { type ParkOutcome, type ParkWriter, parkStory } from "./park";
import { activeRuns, endRun, findRun, type StoredRun } from "./records";
import {
  initRejectedEnding,
  type RunAct,
  type RunEnder,
  type RunOutcomesPort,
  type RunView,
} from "./outcomes";
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
  feedbackNotSent: "run.feedbackNotSent",
} as const;

/** Sends host ops to a run's worker host. */
export interface RunSteering {
  send(
    office: OfficeHandle,
    runId: RunId,
    ops: readonly HostOp[],
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface RunControlDeps {
  readonly clock: Clock;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
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

interface Tracked extends TrackedRun {
  readonly office: OfficeId;
  timer: TimerHandle | null;
  /** Set at the first decision; nothing else is decided for the run after it. */
  ending: Promise<ParkOutcome | null> | null;
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

type Ending = RunEnding;

type StopArgs = { readonly story: string; readonly note?: string | undefined };
type StopResult = { run: RunId };

/** A notice reconcile puts on the office with what it did to a run (DIPO-56). */
export interface ReconcileNotice {
  readonly code: string;
  readonly text: string;
}

function noticeEntry(run: StoredRun, notice: ReconcileNotice): NewEntry {
  return {
    type: "engine.notice",
    ...(run.key === null ? {} : { key: run.key }),
    run: run.runId,
    delta: { level: "warn", code: notice.code, text: notice.text },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunControl implements RunEnder {
  readonly #deps: RunControlDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #inflight = new Set<Promise<unknown>>();
  /** Events at which a cap was reached, as of that event inside its pass (`onEventApplied`). */
  readonly #crossings = new WeakMap<WorkerEvent, FiredCap>();

  constructor(deps: RunControlDeps) {
    this.#deps = deps;
  }

  /** The ingestion hooks: caps and reports after every committed pass, intents at the exit. */
  get hooks(): IngestHooks {
    return {
      onEventApplied: (run, _agent, event) => this.onEventApplied(run, event),
      onWorkerEvents: (run, _agent, events) => this.onWorkerEvents(run, events),
      onInitRejected: (run, _agent, reason) => this.#initRejected(run, reason),
      onEnded: (run, agent, end) => this.onEnded(run, agent, end),
      onFileChanged: (report) => this.#fileChanged(report.run),
    };
  }

  /**
   * The run's host event file changed (0007 section 5, DIPO-45's `ingest.fileChanged`): its
   * ingestion stopped, so the worker is stopped and the story parks `interrupted` with the
   * detail "event file changed" (DIPO-57). A run decided already keeps that decision.
   */
  #fileChanged(run: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) {
      if (tracked === undefined) {
        this.#deps.warn?.("the event file of a run that is not followed changed", { run });
      }
      return;
    }
    this.#begin(tracked, this.interruptedEnding());
  }

  /** The ending of a run whose host event file changed (0007 section 5). */
  interruptedEnding(): RunEnding {
    return {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "interrupted",
      detail: EVENT_FILE_CHANGED,
      endKind: INTERRUPTED_END,
    };
  }

  /**
   * Compares a tracked run's totals with its caps now and stops the worker when one is reached
   * (DIPO-57: after a re-attach caught up); true when the run is ending for a cap.
   */
  checkCaps(run: string): boolean {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return false;
    return this.#checkCaps(tracked);
  }

  /**
   * The run's host was found dead without an exit file after a restart (DIPO-57): like an exit,
   * the turns caught up before it are handled first, then the run is untracked and its outcomes
   * decide (`RunOutcomesPort.onHostLost`).
   */
  onHostLost(run: string, agent: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined) return;
    this.#disarm(tracked);
    const outcomes = this.#deps.outcomes?.();
    const job = (async () => {
      await tracked.turns.catch(() => undefined);
      if (this.#tracked.get(run) === tracked) this.#tracked.delete(run);
      await outcomes?.onHostLost?.({ view: this.#view(tracked), agent, ending: tracked.ending });
    })().catch((error: unknown) => {
      this.#deps.warn?.("deciding a lost worker host failed", { run, reason: messageOf(error) });
    });
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  /** Starts tracking a started run; call it before ingestion starts, so no event is missed. */
  track(office: OfficeId, run: TrackedRun): void {
    if (this.#tracked.has(run.runId)) return;
    const tracked: Tracked = {
      ...run,
      office,
      timer: null,
      ending: null,
      turns: Promise.resolve(),
      lastReport: null,
    };
    this.#tracked.set(run.runId, tracked);
    this.#arm(tracked);
  }

  /** True while the run is tracked (started here and not yet ended by an exit). */
  isTracked(run: string): boolean {
    return this.#tracked.has(run);
  }

  /** Resolves once every park this control started has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every tick; tracked runs keep their stored facts. */
  close(): void {
    for (const tracked of this.#tracked.values()) this.#disarm(tracked);
    this.#tracked.clear();
  }

  /**
   * Inside an ingestion pass, right after a `usage` or `turn` event was folded into the stored
   * totals: compares the totals as of that event with the caps and remembers the event when one
   * is reached. Nothing is written or sent here; `onWorkerEvents` acts after the commit, at the
   * first event that decides, so a blocked report or backstop turn before the crossing wins and
   * the park detail names the total at the crossing. A rolled-back pass leaves only unused marks.
   */
  onEventApplied(run: string, event: WorkerEvent): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const fired = firedCap(
      tracked.caps,
      runTotals(office, tracked.runId, tracked.startedAt, this.#deps.clock.now()),
    );
    if (fired !== null) this.#crossings.set(event, fired);
  }

  /** The events of one committed ingestion pass, in order. */
  onWorkerEvents(run: string, events: readonly WorkerEvent[]): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    const outcomes = this.#deps.outcomes?.();
    for (const event of events) {
      if (tracked.ending !== null) return;
      if (event.t === "initRejected") {
        // 0008 section 2: stop the worker before it does anything (DIPO-51).
        this.#initRejected(run, event.reason);
        return;
      }
      if (
        event.t === "limit" &&
        outcomes !== undefined &&
        (event.status === "rejected" || event.creditsRequired === true)
      ) {
        outcomes.onPlanLimit(this.#view(tracked), {
          credits: event.creditsRequired === true,
          ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
        });
        return;
      }
      if (event.t === "modelSwitched") outcomes?.onModelSwitched(this.#view(tracked), event.to);
      if (event.t === "turn") {
        if (event.capped !== undefined) {
          this.#cap(tracked, "maxTurns", event.capped);
          return;
        }
        const report = event.report;
        if (report !== null) tracked.lastReport = report;
        // A turn after the report feedback answers it (DIPO-51).
        outcomes?.answered(this.#view(tracked));
        if (event.problem?.kind === "planLimit" && outcomes !== undefined) {
          outcomes.onPlanLimit(this.#view(tracked), { credits: false });
          return;
        }
        if (report?.status === "blocked") {
          const permission = report.needsPermission;
          const reason: ParkReason =
            permission === undefined ? "ambiguous-spec" : "needs-permission";
          const detail =
            permission === undefined
              ? (report.question ?? report.summary)
              : `${permission.tool}: ${permission.action}`;
          this.#begin(tracked, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason,
            detail,
            endKind: "blocked",
          });
          return;
        }
        // The backstop, and verify and commit at `done` (DIPO-49), after the pass, in turn order;
        // then the turn's problem, if any (DIPO-51).
        const problem = outcomes === undefined ? undefined : event.problem;
        if (this.#deps.finisher !== undefined || problem !== undefined) {
          this.#afterTurn(tracked, report, problem);
        }
      }
      // The cap as of this event, as the pass saw it (`onEventApplied`); the first crossing wins.
      const fired = this.#crossings.get(event);
      if (fired !== undefined) {
        this.#cap(tracked, fired.cap, fired.detail);
        return;
      }
    }
  }

  /**
   * The worker's exit was ingested: the tick stops, and once the turns before the exit are
   * handled the run's outcomes decide what follows (DIPO-51). Without outcomes the intent that
   * explains the exit is resolved here.
   */
  onEnded(run: string, agent?: string, end?: IngestedExit): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined) return;
    this.#disarm(tracked);
    const outcomes = this.#deps.outcomes?.();
    if (outcomes !== undefined && agent !== undefined && end !== undefined) {
      // The turns before the exit are decided first, with the run still tracked; then the run is
      // untracked and the exit decided (DIPO-51).
      const job = (async () => {
        await tracked.turns.catch(() => undefined);
        if (this.#tracked.get(run) === tracked) this.#tracked.delete(run);
        await outcomes.onExit({
          view: this.#view(tracked),
          agent,
          turns: Promise.resolve(),
          ending: tracked.ending,
          end,
        });
      })().catch((error: unknown) => {
        this.#deps.warn?.("deciding a worker's exit failed", {
          run,
          reason: messageOf(error),
        });
      });
      this.#inflight.add(job);
      void job.finally(() => this.#inflight.delete(job));
      return;
    }
    this.#tracked.delete(run);
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const at = this.#deps.clock.now();
    office.immediate(() => {
      const explained = outcomeOfIntent(office, tracked.runId);
      if (explained !== null && explained.intent.resolvedAt === null) {
        resolveIntent(office, tracked.runId, explained.intent.intentId, explained.outcome, at);
      }
    });
  }

  // ---- the run ender of worker outcomes (DIPO-51) ------------------------------------------------

  /** True while the run is tracked and nothing was decided for it yet. */
  live(runId: string): boolean {
    const tracked = this.#tracked.get(runId);
    return tracked !== undefined && tracked.ending === null;
  }

  /** The first decision on a tracked run, parking it; false when one was decided already. */
  begin(runId: string, ending: RunEnding): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined || tracked.ending !== null) return false;
    this.#begin(tracked, ending);
    return tracked.ending !== null;
  }

  /**
   * The first decision on a tracked run without a park (a reassign or a plan-limit hold): the
   * intent is stored, then its ops are sent. Nothing else is decided for the run after it; the
   * worker's exit is decided from the intent. False when a decision was made already.
   */
  act(runId: string, act: RunAct): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined || tracked.ending !== null) return false;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return false;
    this.#disarm(tracked);
    const intentId = office.immediate(() =>
      recordIntent(office, tracked.runId, act.intent, act.detail, this.#deps.clock.now()),
    );
    const done = (async (): Promise<null> => {
      let error: string | null = null;
      if (act.ops.length > 0) {
        try {
          const sent = await this.#deps.steering.send(office, tracked.runId, act.ops);
          if (!sent.ok) error = sent.reason;
        } catch (thrown) {
          error = messageOf(thrown);
        }
      }
      const at = this.#deps.clock.now();
      office.immediate(() => markIntentSent(office, tracked.runId, intentId, at, error));
      return null;
    })();
    tracked.ending = done;
    this.#inflight.add(done);
    void done.finally(() => this.#inflight.delete(done));
    return true;
  }

  /** Parks a run whose worker exited (a decision at the exit, DIPO-51). */
  park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: RunEnding,
  ): Promise<ParkOutcome> {
    return this.#end(office, run, work, ending, this.#writer(office, office.officeId));
  }

  #view(tracked: Tracked): RunView {
    return {
      office: tracked.office,
      runId: tracked.runId,
      work: tracked.work,
      caps: tracked.caps,
      startedAt: tracked.startedAt,
      snapshot: tracked.snapshot ?? null,
    };
  }

  /** A `system/init` that failed its checks: stop the worker and park `worker-failed`. */
  #initRejected(run: string, reason: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    this.#begin(tracked, initRejectedEnding(tracked.work.story, reason));
  }

  /** `work.stop`: see the file comment. */
  async stop(ctx: AsyncCommandContext, args: StopArgs): Promise<CommandOutcome<StopResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const find = () =>
      activeRuns(handle).find((run) => run.kind === "story" && run.key === identity.key);
    let run = find();
    // A decision already under way (a cap or a report) finishes first; then the run has ended.
    const pending = run === undefined ? undefined : this.#tracked.get(run.runId)?.ending;
    if (pending !== undefined && pending !== null) {
      await pending.catch(() => null);
      run = find();
    }
    if (run === undefined) {
      throw new CommandError(
        STORY_NOT_RUNNING,
        `${identity.story} has no running worker to stop.`,
        { story: identity.story },
      );
    }
    const note = args.note?.trim();
    const ending: Ending = {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "stopped",
      detail: note === undefined || note === "" ? STOPPED_DETAIL : note,
      endKind: "stopped",
    };
    const tracked = this.#tracked.get(run.runId);
    const work = tracked?.work ?? workRefOf(handle, run.runId) ?? undefined;
    if (tracked !== undefined) this.#disarm(tracked);
    const done = this.#end(handle, run, work, ending, (fn) => ctx.commit(fn));
    if (tracked !== undefined) tracked.ending = done;
    await done;
    return { result: { run: run.runId } };
  }

  /** True while a decision on the run (a cap, a report, `work.stop`) is being carried out. */
  isEnding(run: string): boolean {
    const ending = this.#tracked.get(run)?.ending;
    return ending !== undefined && ending !== null;
  }

  /**
   * Reconcile (DIPO-56, 0007 section 6): the run is active in the database, but its story's
   * status is no longer In Progress or In Review, or the story was removed. The engine records a
   * `stop` intent, sends the stop sequence to its worker host if one still answers, and ends the
   * run with `endKind`, together with `notice`, in one transaction. Nothing is parked: the
   * story's status already says where it is.
   *
   * The decision is claimed first, before any await: no after-turn work (verify and commit, an
   * In Review commit, a second run summary) starts or commits once reconcile decided, since it
   * claims the run's end the same way. A decision already being carried out wins; reconcile then
   * waits for it and does nothing more.
   */
  async stopForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    notice: ReconcileNotice,
    endKind = RECONCILED_END,
  ): Promise<void> {
    const tracked = this.#tracked.get(run.runId);
    if (tracked?.ending != null) {
      await tracked.ending.catch(() => null);
      return;
    }
    const { promise: mine, resolve } = Promise.withResolvers<ParkOutcome | null>();
    if (tracked !== undefined) {
      this.#disarm(tracked);
      tracked.ending = mine;
    }
    try {
      await this.#stopForReconcile(office, run, notice, endKind, tracked?.lastReport ?? null);
    } finally {
      resolve(null);
      if (tracked !== undefined && this.#tracked.get(run.runId) === tracked) {
        this.#tracked.delete(run.runId);
      }
    }
  }

  async #stopForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    notice: ReconcileNotice,
    endKind: string,
    lastReport: WorkerReport | null,
  ): Promise<void> {
    const intentId = office.immediate(() =>
      recordIntent(office, run.runId, "stop", notice.text, this.#deps.clock.now()),
    );
    let error: string | null = null;
    try {
      const sent = await this.#deps.steering.send(
        office,
        run.runId,
        this.#deps.encode({ kind: "stop" }),
      );
      if (!sent.ok) error = sent.reason;
    } catch (thrown) {
      error = messageOf(thrown);
    }
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      markIntentSent(office, run.runId, intentId, at, error);
      endRun(office, run.runId, at, endKind);
      office.run(
        `update agents set end_reason = coalesce(end_reason, $kind)
         where office_id = $office_id and run_id = $run and ended_at is null`,
        { kind: endKind, run: run.runId },
      );
      const entries = withWorkViews(office, [noticeEntry(run, notice)]);
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    // The run summary (DIPO-49), as for every run that ends here.
    await this.#deps.finisher?.summarize(office, run, lastReport).catch((thrown: unknown) => {
      this.#deps.warn?.("storing the run summary failed", {
        run: run.runId,
        reason: messageOf(thrown),
      });
    });
  }

  /**
   * Reconcile (DIPO-56, 0010 section 7 "Worktree or branch changed by hand"): the running story's
   * worktree or branch changed by hand. The worker is stopped and the story parks
   * `scope-violation` with the evidence as detail. The park is not written on the branch, since
   * the worktree can no longer be trusted; `notice` says why and the park's own notice says what
   * is missing.
   */
  async parkForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    detail: string,
    notice: ReconcileNotice,
  ): Promise<ParkOutcome | null> {
    const tracked = this.#tracked.get(run.runId);
    // A decision already being carried out wins (see `stopForReconcile`).
    if (tracked?.ending != null) return tracked.ending.catch(() => null);
    if (tracked !== undefined) this.#disarm(tracked);
    const work = tracked?.work ?? workRefOf(office, run.runId) ?? undefined;
    const write = (fn: () => readonly NewEntry[]): void => {
      const at = this.#deps.clock.now();
      const appended = office.immediate(() => {
        const entries = fn() ?? [];
        appendEntries(office, entries, { at });
        return entries.length;
      });
      if (appended > 0) this.#deps.onChanged?.(office.officeId);
    };
    write(() => [noticeEntry(run, notice)]);
    const done = this.#end(
      office,
      run,
      work,
      {
        intent: "stop",
        ops: this.#deps.encode({ kind: "stop" }),
        reason: "scope-violation",
        detail,
        endKind: RECONCILED_END,
      },
      write,
      {
        write: () =>
          Promise.reject(
            new Error("its worktree or branch changed by hand, so dipo writes nothing there"),
          ),
      },
    );
    if (tracked !== undefined) tracked.ending = done;
    return done;
  }

  /** The command `work.stop`. */
  get feature(): FeatureModule {
    return {
      name: "run-control",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workStop,
          handle: (ctx, args) => this.stop(ctx, args),
        });
      },
    };
  }

  // ---- caps ------------------------------------------------------------------------------------

  #arm(tracked: Tracked): void {
    if (tracked.ending !== null || tracked.timer !== null) return;
    tracked.timer = this.#deps.clock.setTimeout(() => {
      tracked.timer = null;
      if (tracked.ending !== null || !this.#tracked.has(tracked.runId)) return;
      if (!this.#checkCaps(tracked)) this.#arm(tracked);
    }, this.#deps.tickMs ?? CAP_TICK_MS);
  }

  #disarm(tracked: Tracked): void {
    if (tracked.timer !== null) this.#deps.clock.clearTimeout(tracked.timer);
    tracked.timer = null;
  }

  /** Compares the run's totals with its caps; true when one fired and the run is ending. */
  #checkCaps(tracked: Tracked): boolean {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return false;
    const fired = firedCap(
      tracked.caps,
      runTotals(office, tracked.runId, tracked.startedAt, this.#deps.clock.now()),
    );
    if (fired === null) return false;
    this.#cap(tracked, fired.cap, fired.detail);
    return true;
  }

  #cap(tracked: Tracked, cap: CapName, detail: string): void {
    this.#begin(tracked, {
      intent: "cap",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "budget-exceeded",
      detail: cap === "maxTurns" && !detail.startsWith("turn cap") ? `turn cap: ${detail}` : detail,
      endKind: "capped",
    });
  }

  // ---- ending a run ----------------------------------------------------------------------------

  /** The first decision on a tracked run, outside any command. */
  #begin(tracked: Tracked, ending: Ending): void {
    this.#disarm(tracked);
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const run = findRun(office, tracked.runId);
    if (run === null || run.endedAt !== null) return;
    const write = (fn: () => readonly NewEntry[]): void => {
      const at = this.#deps.clock.now();
      const appended = office.immediate(() => {
        const entries = fn() ?? [];
        appendEntries(office, entries, { at });
        return entries.length;
      });
      if (appended > 0) this.#deps.onChanged?.(tracked.office);
    };
    const done = this.#end(office, run, tracked.work, ending, write);
    tracked.ending = done;
    const settled = done.catch((error: unknown) => {
      this.#deps.warn?.("parking a run failed", { run: tracked.runId, reason: messageOf(error) });
      return null;
    });
    this.#inflight.add(settled);
    void settled.finally(() => this.#inflight.delete(settled));
  }

  /**
   * Records the intent (synchronously, before the first await), sends its ops through the host and
   * parks the story. A send that fails leaves the intent `failed` and puts a notice on the office;
   * the park still happens. Every entry it writes carries the run's work view where its type has
   * one (DIPO-52's `withWorkViews`), derived in the transaction that wrote the facts.
   */
  #end(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: Ending,
    commit: (fn: () => readonly NewEntry[]) => void,
    writer: ParkWriter = this.#deps.writer,
  ): Promise<ParkOutcome> {
    const write = (fn: () => readonly NewEntry[]): void =>
      commit(() => withWorkViews(office, fn()));
    const intentId = office.immediate(() =>
      recordIntent(
        office,
        run.runId,
        ending.intent,
        ending.intentDetail ?? ending.detail,
        this.#deps.clock.now(),
      ),
    );
    return (async () => {
      const notice = ending.notice;
      if (notice !== undefined) {
        write(() => [
          {
            type: "engine.notice",
            ...(run.key === null ? {} : { key: run.key }),
            run: run.runId,
            delta: notice,
          },
        ]);
      }
      let error: string | null = null;
      if (ending.ops.length > 0) {
        try {
          const sent = await this.#deps.steering.send(office, run.runId, ending.ops);
          if (!sent.ok) error = sent.reason;
        } catch (thrown) {
          error = messageOf(thrown);
        }
      }
      const at = this.#deps.clock.now();
      office.immediate(() => markIntentSent(office, run.runId, intentId, at, error));
      if (error !== null) {
        write(() => [
          {
            type: "engine.notice",
            ...(run.key === null ? {} : { key: run.key }),
            run: run.runId,
            delta: {
              level: "warn",
              code: CONTROL_NOTICES.notSent,
              text: `${run.story ?? run.runId}: dipo could not send ${ending.intent} to its worker (${error}); if the worker still runs, it is no longer followed by a run.`,
            },
          },
        ]);
      }
      this.#deps.flushOutput?.(office.officeId, run.runId);
      const parked = await parkStory(
        {
          office,
          writer,
          now: () => this.#deps.clock.now(),
          write,
          implemented: this.#deps.implemented ?? (() => false),
        },
        {
          run,
          ...(work === undefined ? {} : { work }),
          reason: ending.reason,
          detail: ending.detail,
          endKind: ending.endKind,
        },
      );
      // The run summary (DIPO-49): every run that ends here gets one.
      await this.#deps.finisher
        ?.summarize(office, run, this.#tracked.get(run.runId)?.lastReport ?? ending.report ?? null)
        .catch((thrown: unknown) => {
          this.#deps.warn?.("storing the run summary failed", {
            run: run.runId,
            reason: messageOf(thrown),
          });
        });
      // The park commit is read again at the branch tip (DIPO-56), unless nothing was written there.
      if (writer === this.#deps.writer) await this.#refresh(office, run, "parked");
      return parked;
    })();
  }

  // ---- after every turn (DIPO-49) --------------------------------------------------------------

  /** Queues the after-turn work of one turn; turns of a run are handled one at a time. */
  #afterTurn(tracked: Tracked, report: WorkerReport | null, problem?: TurnProblem): void {
    const job = tracked.turns
      .then(() => this.#runTurn(tracked, report, problem))
      .catch((error: unknown) => {
        this.#deps.warn?.("verify and commit after a turn failed", {
          run: tracked.runId,
          reason: messageOf(error),
        });
      });
    tracked.turns = job;
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  async #runTurn(
    tracked: Tracked,
    report: WorkerReport | null,
    problem?: TurnProblem,
  ): Promise<void> {
    if (tracked.ending !== null) return;
    const finisher = this.#deps.finisher;
    const decided =
      finisher === undefined ? "continue" : await this.#finishTurn(tracked, finisher, report);
    // A turn the finisher let continue: its problem decides next (DIPO-51).
    const outcomes = this.#deps.outcomes?.();
    if (decided === "continue" && problem !== undefined && outcomes !== undefined) {
      if (tracked.ending === null) await outcomes.onTurnProblem(this.#view(tracked), problem);
    }
  }

  /** Verify and commit after one turn (DIPO-49); `continue` when the turn decided nothing. */
  async #finishTurn(
    tracked: Tracked,
    finisher: RunFinisher,
    report: WorkerReport | null,
  ): Promise<"continue" | "decided"> {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return "decided";
    const run = findRun(office, tracked.runId);
    if (run === null || run.endedAt !== null) return "decided";
    const { promise: mine, resolve: settle } = Promise.withResolvers<ParkOutcome | null>();
    const claim = (): boolean => {
      if (tracked.ending !== null) return tracked.ending === mine;
      this.#disarm(tracked);
      tracked.ending = mine;
      return true;
    };
    const write = this.#writer(office, tracked.office);
    try {
      const decision = await finisher.afterTurn({
        office,
        run,
        work: tracked.work,
        report,
        snapshot: tracked.snapshot ?? null,
        live: () => tracked.ending === null || tracked.ending === mine,
        claimEnd: claim,
        write: (fn) => write(() => withWorkViews(office, fn())),
        flushOutput: () => this.#deps.flushOutput?.(office.officeId, run.runId),
      });
      switch (decision.kind) {
        case "continue":
          return "continue";
        case "park": {
          if (!claim()) return "decided";
          const outcome = await this.#end(
            office,
            run,
            tracked.work,
            {
              intent: "park",
              ops: [{ closeStdin: true }],
              reason: decision.reason,
              detail: decision.detail,
              endKind: decision.endKind,
              report,
            },
            write,
          );
          settle(outcome);
          return "decided";
        }
        case "feedback":
          if (tracked.ending !== null) return "decided";
          await this.#sendFeedback(office, run, decision.text, write);
          return "decided";
        case "ended":
          // The In Review commit is read again at the branch tip (DIPO-56).
          await this.#refresh(office, run, "In Review");
          // The worker's turn ended and it waits on stdin: closing it ends the worker.
          await this.#deps.steering.send(office, run.runId, [{ closeStdin: true }]).catch(() => {
            // A worker that already exited needs nothing more.
          });
          return "decided";
      }
    } finally {
      settle(null);
    }
  }

  /**
   * Reads the run's story again at its branch tip after a status commit there (DIPO-56), so the
   * story view and snapshots read the new status at once. A read that fails is logged; the next
   * index pass reads it.
   */
  async #refresh(office: OfficeHandle, run: StoredRun, what: string): Promise<void> {
    if (run.key === null || this.#deps.refreshStory === undefined) return;
    await this.#deps.refreshStory(office.officeId, run.key).catch((thrown: unknown) => {
      this.#deps.warn?.(`reading the ${what} story again failed`, {
        run: run.runId,
        reason: messageOf(thrown),
      });
    });
  }

  /** Sends a verify feedback item as the next user message, stored first as a `steer` intent. */
  async #sendFeedback(
    office: OfficeHandle,
    run: StoredRun,
    text: string,
    write: (fn: () => readonly NewEntry[]) => void,
  ): Promise<void> {
    const intentId = office.immediate(() =>
      recordIntent(office, run.runId, "steer", "verify feedback", this.#deps.clock.now()),
    );
    let error: string | null = null;
    try {
      const sent = await this.#deps.steering.send(
        office,
        run.runId,
        this.#deps.encode({ kind: "steer", text }),
      );
      if (!sent.ok) error = sent.reason;
    } catch (thrown) {
      error = messageOf(thrown);
    }
    const at = this.#deps.clock.now();
    office.immediate(() => markIntentSent(office, run.runId, intentId, at, error));
    if (error !== null) {
      write(() => [
        {
          type: "engine.notice",
          ...(run.key === null ? {} : { key: run.key }),
          run: run.runId,
          delta: {
            level: "warn",
            code: CONTROL_NOTICES.feedbackNotSent,
            text: `${run.story ?? run.runId}: dipo could not send the verify feedback to its worker (${error}).`,
          },
        },
      ]);
    }
  }

  /** Writes entries outside a command: one transaction, then subscribers are told. */
  #writer(office: OfficeHandle, officeId: OfficeId): (fn: () => readonly NewEntry[]) => void {
    return (fn) => {
      const at = this.#deps.clock.now();
      const appended = office.immediate(() => {
        const entries = fn() ?? [];
        appendEntries(office, entries, { at });
        return entries.length;
      });
      if (appended > 0) this.#deps.onChanged?.(officeId);
    };
  }
}
