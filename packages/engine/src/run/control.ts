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
//   does the same at that turn, so a later turn of a queued message never overrides it. A crossing
//   turn that carries a `done` report is the exception (0008 amendment of 2026-10-19, DIPO-205):
//   it takes the normal done path (verify and commit), a `cap` run step names the crossed cap, and
//   no cap ends the run while that path runs.
//   A reviewer session (DIPO-219, 0019 sections 4 and 13) counts the story's budget, with its review
//   allowances, and its own turns and minutes against the reviewer's caps: the budget parks
//   `budget-exceeded` with cause `review`, the reviewer's turn or minute cap `worker-failed` with
//   cause `review-cap`. Its valid report goes to worker outcomes after the backstop (`onReview`).
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
// - `work.steer` and `work.pause` (DIPO-163, `intervene.ts`): the maintainer's message to a live
//   worker, and the pause that closes its stdin after 10 minutes on the cap tick.
//
// Every op is stored as a pending intent before it is sent (`intents.ts`), and when the worker
// exits the intent that explains the exit is resolved with its outcome. A decision without a park
// (`act`) whose intent cannot be stored sends nothing: the failure is logged with its error code
// and the run stays as it was, with its cap tick (DIPO-119). After the first decision
// on a run nothing else is decided for it: later events of the same or a later pass are ignored.
//
// A refused start (`startRefused`, DIPO-108) is stopped at once as a `start-failed` stop, without a
// park; its exit is decided by worker outcomes like any start failure.
//
// Worker outcomes (DIPO-51, `outcomes.ts`): a rejected init, a plan limit, a classifier switch
// and a turn's problem (no valid report, a full context, an execution error, a start failure) are
// handed to the run's outcomes, and so is the worker's exit once the turns before it are done.
// Run control is their `RunEnder`: it records the intent, sends the ops and parks.

import {
  type OfficeId,
  type ParkReason,
  type WorkRef,
  workStop,
} from "@dipsaus-orchestrator/contract";

import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit, IngestHooks } from "../ingest/ingestor";
import { background } from "../platform/background";
import type { WorkerEvent, WorkerReport } from "../workers/types";

import {
  type CapName,
  type FiredCap,
  firedCap,
  REVIEWER_ROLE,
  reviewTotals,
  runCaps,
  runTotals,
} from "./caps";
import { capDetail, capEnding, reviewCapEnding, RunEndings } from "./control-endings";
import { ReconcileStops } from "./control-reconcile";
import {
  CAP_TICK_MS,
  disarm,
  EVENT_FILE_CHANGED,
  INTERRUPTED_END,
  type ReconcileNotice,
  RECONCILED_END,
  type RunControlDeps,
  type RunEnding,
  type StopArgs,
  type StopResult,
  type Tracked,
  type TrackedRun,
  viewOf,
} from "./control-types";
import { AfterTurns } from "./control-turns";
import { Interventions } from "./intervene";
import { outcomeOfIntent, resolveIntent } from "./intents";
import { initRejectedEnding, type RunAct, type RunEnder, startRefusedAct } from "./outcome-types";
import { PARK_CAUSES, type ParkOutcome } from "./park";
import { findRun, type StoredRun } from "./records";

export {
  CAP_TICK_MS,
  CONTROL_NOTICES,
  EVENT_FILE_CHANGED,
  INTERRUPTED_END,
  RECONCILED_END,
  STOPPED_DETAIL,
  STORY_NOT_RUNNING,
} from "./control-types";
export type {
  ReconcileNotice,
  RunControlDeps,
  RunEnding,
  RunSteering,
  TrackedRun,
} from "./control-types";

export class RunControl implements RunEnder {
  readonly #deps: RunControlDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #inflight = new Set<Promise<unknown>>();
  /** Events at which a cap was reached, as of that event inside its pass (`onEventApplied`). */
  readonly #crossings = new WeakMap<WorkerEvent, FiredCap>();
  readonly #endings: RunEndings;
  readonly #turns: AfterTurns;
  readonly #reconcile: ReconcileStops;
  readonly #interventions: Interventions;

  constructor(deps: RunControlDeps) {
    this.#deps = deps;
    this.#endings = new RunEndings(deps, this.#tracked, this.#inflight);
    this.#turns = new AfterTurns(deps, this.#endings, this.#inflight);
    this.#reconcile = new ReconcileStops(deps, this.#tracked, this.#endings);
    this.#interventions = new Interventions(deps, this.#tracked, this.#inflight);
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
    this.#endings.begin(tracked, this.interruptedEnding());
  }

  /** The ending of a run whose host event file changed (0007 section 5). */
  interruptedEnding(): RunEnding {
    return {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "interrupted",
      cause: PARK_CAUSES.build,
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
    if (tracked === undefined || tracked.ending !== null || tracked.capped !== null) return false;
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
    disarm(this.#deps.clock, tracked);
    const outcomes = this.#deps.outcomes?.();
    background(
      async () => {
        await tracked.turns.catch(() => undefined);
        if (this.#tracked.get(run) === tracked) this.#tracked.delete(run);
        await outcomes?.onHostLost?.({ view: viewOf(tracked), agent, ending: tracked.ending });
      },
      {
        failed: "deciding a lost worker host failed",
        fields: { run },
        log: this.#deps.warn,
        inflight: this.#inflight,
      },
    );
  }

  /** Starts tracking a started run; call it before ingestion starts, so no event is missed. */
  track(office: OfficeId, run: TrackedRun): void {
    if (this.#tracked.has(run.runId)) return;
    const tracked: Tracked = {
      ...run,
      office,
      timer: null,
      ending: null,
      unstored: null,
      turns: Promise.resolve(),
      lastReport: null,
      capped: null,
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
    for (const tracked of this.#tracked.values()) disarm(this.#deps.clock, tracked);
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
    if (tracked === undefined || tracked.ending !== null || tracked.capped !== null) return;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const fired = this.#fired(office, tracked);
    if (fired !== null) this.#crossings.set(event, fired);
  }

  /** The events of one committed ingestion pass, in order. */
  onWorkerEvents(run: string, events: readonly WorkerEvent[]): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    const outcomes = this.#deps.outcomes?.();
    // A crossing at a usage event that a done turn of the same pass follows belongs to that turn.
    let pending: FiredCap | null = null;
    for (const [index, event] of events.entries()) {
      if (tracked.ending !== null) return;
      if (event.t === "initRejected") {
        // 0008 section 2: stop the worker before it does anything (DIPO-51).
        this.#initRejected(run, event.reason);
        return;
      }
      if (event.t === "startRefused") {
        // 0008 amendment of 2026-10-12 (DIPO-108): stop it before it does anything; no park.
        this.act(run, startRefusedAct(event.reason));
        return;
      }
      if (
        event.t === "limit" &&
        outcomes !== undefined &&
        (event.status === "rejected" || event.creditsRequired === true)
      ) {
        outcomes.onPlanLimit(viewOf(tracked), {
          credits: event.creditsRequired === true,
          ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
          ...(event.scope === undefined ? {} : { scope: event.scope }),
        });
        return;
      }
      // A warning lets the run go on; new runs on its scope wait for the reset (DIPO-61).
      if (event.t === "limit" && event.status === "allowed_warning") {
        outcomes?.onPlanWarning?.(viewOf(tracked), {
          ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
          ...(event.scope === undefined ? {} : { scope: event.scope }),
        });
      }
      if (event.t === "modelSwitched") outcomes?.onModelSwitched(viewOf(tracked), event.to);
      if (event.t === "turn") {
        // A done report on the turn that crosses a cap takes the done path (0008 amendment of
        // 2026-10-19, DIPO-205); without a finisher nothing could commit it, so the cap parks.
        const crossed =
          tracked.capped !== null || this.#deps.finisher === undefined
            ? null
            : event.capped !== undefined
              ? { cap: "maxTurns" as const, detail: capDetail("maxTurns", event.capped) }
              : (this.#crossings.get(event) ?? pending);
        if (event.report?.status === "done" && crossed !== null) {
          tracked.lastReport = event.report;
          outcomes?.answered(viewOf(tracked));
          this.#cappedDone(tracked, event.report, crossed);
          continue;
        }
        if (event.capped !== undefined && tracked.capped === null) {
          this.#cap(tracked, "maxTurns", event.capped);
          return;
        }
        const report = event.report;
        if (report !== null) tracked.lastReport = report;
        // A turn after the report feedback answers it (DIPO-51).
        outcomes?.answered(viewOf(tracked));
        if (event.problem?.kind === "planLimit" && outcomes !== undefined) {
          outcomes.onPlanLimit(viewOf(tracked), { credits: false });
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
          this.#endings.begin(tracked, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason,
            cause: permission === undefined ? PARK_CAUSES.question : PARK_CAUSES.build,
            detail,
            endKind: "blocked",
          });
          return;
        }
        // The backstop, and verify and commit at `done` (DIPO-49), after the pass, in turn order;
        // then the turn's problem, if any (DIPO-51), or a reviewer's valid report (DIPO-219).
        const problem = outcomes === undefined ? undefined : event.problem;
        const review = outcomes === undefined ? undefined : event.review;
        if (this.#deps.finisher !== undefined || problem !== undefined || review !== undefined) {
          this.#turns.queue(tracked, report, problem, null, review);
        }
      }
      // The cap as of this event, as the pass saw it (`onEventApplied`); the first crossing wins.
      const fired = tracked.capped === null ? this.#crossings.get(event) : undefined;
      if (fired !== undefined) {
        if (event.t !== "turn" && this.#doneTurnAhead(events, index)) {
          pending = fired;
          continue;
        }
        this.#cap(tracked, fired.cap, fired.detail);
        return;
      }
    }
  }

  /** True when the first turn after `index` in the pass carries a done report a finisher handles. */
  #doneTurnAhead(events: readonly WorkerEvent[], index: number): boolean {
    if (this.#deps.finisher === undefined) return false;
    const next = events.slice(index + 1).find((event) => event.t === "turn");
    return next?.t === "turn" && next.report?.status === "done";
  }

  /**
   * A done report arrived on the turn that crossed `crossed`: the run takes the normal done path
   * (verify, commit, In Review) and no cap ends it meanwhile. The step keeps the crossed cap; a
   * red verify parks `verify-failing` with cause `capped` (`verify-commit.ts`).
   */
  #cappedDone(tracked: Tracked, report: WorkerReport, crossed: FiredCap): void {
    tracked.capped = crossed;
    disarm(this.#deps.clock, tracked);
    this.#turns.queue(tracked, report, undefined, crossed);
  }

  /**
   * The worker's exit was ingested: the tick stops, and once the turns before the exit are
   * handled the run's outcomes decide what follows (DIPO-51). Without outcomes the intent that
   * explains the exit is resolved here.
   */
  onEnded(run: string, agent?: string, end?: IngestedExit): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined) return;
    disarm(this.#deps.clock, tracked);
    const outcomes = this.#deps.outcomes?.();
    if (outcomes !== undefined && agent !== undefined && end !== undefined) {
      // The turns before the exit are decided first, with the run still tracked; then the run is
      // untracked and the exit decided (DIPO-51).
      background(
        async () => {
          await tracked.turns.catch(() => undefined);
          if (this.#tracked.get(run) === tracked) this.#tracked.delete(run);
          await outcomes.onExit({
            view: viewOf(tracked),
            agent,
            turns: Promise.resolve(),
            ending: tracked.ending,
            end,
          });
        },
        {
          failed: "deciding a worker's exit failed",
          fields: { run },
          log: this.#deps.warn,
          inflight: this.#inflight,
        },
      );
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
    this.#endings.begin(tracked, ending);
    return tracked.ending !== null;
  }

  /**
   * The first decision on a tracked run without a park (a reassign or a plan-limit hold): the
   * intent is stored, then its ops are sent. Nothing else is decided for the run after it; the
   * worker's exit is decided from the intent. False when a decision was made already, or when
   * the intent could not be stored: then no op is sent and the failure is logged (DIPO-119).
   */
  act(runId: string, act: RunAct): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined || tracked.ending !== null) return false;
    return this.#endings.act(tracked, act);
  }

  /** Parks a run whose worker exited (a decision at the exit, DIPO-51). */
  park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: RunEnding,
  ): Promise<ParkOutcome> {
    return this.#endings.park(office, run, work, ending);
  }

  /** A `system/init` that failed its checks: stop the worker and park `worker-failed`. */
  #initRejected(run: string, reason: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    this.#endings.begin(
      tracked,
      initRejectedEnding(
        tracked.work.story,
        reason,
        reviewing(tracked) ? PARK_CAUSES.review : PARK_CAUSES.build,
      ),
    );
  }

  /** `work.stop`: see the file comment. */
  stop(ctx: AsyncCommandContext, args: StopArgs): Promise<CommandOutcome<StopResult>> {
    return this.#endings.stop(ctx, args);
  }

  /** True while a decision on the run (a cap, a report, `work.stop`) is being carried out. */
  isEnding(run: string): boolean {
    const ending = this.#tracked.get(run)?.ending;
    return ending !== undefined && ending !== null;
  }

  /** Reconcile (DIPO-56, 0007 section 6): stops a run whose story left In Progress or In Review. */
  stopForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    notice: ReconcileNotice,
    endKind = RECONCILED_END,
  ): Promise<void> {
    return this.#reconcile.stopForReconcile(office, run, notice, endKind);
  }

  /** Reconcile (DIPO-56): parks a run whose worktree or branch changed by hand `scope-violation`. */
  parkForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    detail: string,
    notice: ReconcileNotice,
  ): Promise<ParkOutcome | null> {
    return this.#reconcile.parkForReconcile(office, run, detail, notice);
  }

  /** The commands `work.stop`, `work.steer` and `work.pause`. */
  get feature(): FeatureModule {
    const intervene = this.#interventions.feature;
    return {
      name: "run-control",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workStop,
          handle: (ctx, args) => this.stop(ctx, args),
        });
        intervene.register(registry);
      },
    };
  }

  // ---- caps ------------------------------------------------------------------------------------

  #arm(tracked: Tracked): void {
    if (tracked.ending !== null || tracked.timer !== null) return;
    tracked.timer = this.#deps.clock.setTimeout(() => {
      tracked.timer = null;
      if (tracked.ending !== null || !this.#tracked.has(tracked.runId)) return;
      // A turn problem whose intent failed is decided now, before the caps (DIPO-123).
      const retry = tracked.unstored;
      if (retry !== null && this.act(tracked.runId, retry)) return;
      // A pause older than 10 minutes closes the worker's stdin (DIPO-163).
      this.#interventions.expire(tracked);
      if (!this.#checkCaps(tracked)) this.#arm(tracked);
    }, this.#deps.tickMs ?? CAP_TICK_MS);
  }

  /** Compares the run's totals with its caps; true when one fired and the run is ending. */
  #checkCaps(tracked: Tracked): boolean {
    if (tracked.capped !== null) return false;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return false;
    const fired = this.#fired(office, tracked);
    if (fired === null) return false;
    this.#cap(tracked, fired.cap, fired.detail);
    return true;
  }

  /**
   * The first cap the run reached now, or null. The caps it counts against now (DIPO-143), the
   * tracked caps serving for a legacy run. A reviewer session (0019 sections 4 and 13) counts the
   * story's budget with its review allowances, and its own turns and minutes against the
   * reviewer's caps; the developer's turn and minute caps never count the review.
   */
  #fired(office: OfficeHandle, tracked: Tracked): FiredCap | null {
    const run = findRun(office, tracked.runId);
    if (run === null) return null;
    const caps = runCaps(office, run, tracked.caps);
    const now = this.#deps.clock.now();
    if (reviewing(tracked)) {
      return firedCap(
        {
          budgetTokens: caps.budgetTokens,
          maxTurns: caps.reviewMaxTurns ?? tracked.caps.maxTurns,
          maxMinutes: caps.reviewMaxMinutes ?? tracked.caps.maxMinutes,
        },
        reviewTotals(office, tracked.runId, tracked.work.agent, tracked.startedAt, now),
      );
    }
    return firedCap(caps, runTotals(office, tracked.runId, tracked.startedAt, now));
  }

  #cap(tracked: Tracked, cap: CapName, detail: string): void {
    const ending = reviewing(tracked)
      ? reviewCapEnding(this.#deps.encode, cap, detail)
      : capEnding(this.#deps.encode, cap, detail);
    this.#endings.begin(tracked, ending);
  }
}

/** True for a reviewer session (0019 section 4): its work names the reviewer role. */
function reviewing(tracked: Tracked): boolean {
  return tracked.work.role === REVIEWER_ROLE;
}
