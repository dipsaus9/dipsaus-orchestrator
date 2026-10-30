// Run control (DIPO-50; 0008 sections 6 and 7, 0005 section 4): the engine's caps, the parks a
// worker's report asks for and `story.park` of a story with a run.
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
//   A reviewer session (0002) counts its own tokens, turns and minutes against the reviewer's own
//   caps, never the story's budget; any of them reached parks `worker-failed`. Its valid report goes to worker outcomes after the backstop (`onReview`).
// - Reports. A turn whose report is `blocked` parks the story `ambiguous-spec` with the question
//   (a box worker has every permission, so no report names a denied call, DIPO-342). The engine
//   records a `park` intent and closes the worker's stdin; worktree, branch and session are kept.
//   A question goes through the live-question rule first (DIPO-272, 0021 section 11): while a TUI is connected it is asked
//   live (`RunControlDeps.questions`) and the worker waits on stdin for the answer, with no park, for
//   at most `timeouts.questionWaitMinutes`; if the last TUI closes or the wait ends first,
//   `parkOnQuestion` parks it then. A park with no live question asks the report's question itself
//   (`ParkRequest.question`, DIPO-159). A blocked report during an
//   open conflict hand-off fails it (DIPO-149, `conflicts.ts`); the failure that reaches the run's
//   conflict cap parks `conflict` instead.
// - Report data (DIPO-186). The proposals of every report, done or blocked, are stored for the
//   maintainer (`storeProposals`, deduplicated by title and paths); storing them changes nothing
//   about the story, the run or the commit.
// - `story.park { story, note }` of a story with a run (`parkByMaintainer`, 0020). The engine
//   records a `stop` intent, sends the stop sequence through the host (the adapter's `encode`: a
//   now-priority message, stdin closed, SIGTERM after 10 s, SIGKILL after 30 s) and parks the
//   story `by-maintainer` with the note; branch and box are kept.
//
// - Stream drift (DIPO-315). A `streamDrift` event the ingestor marks as deciding (`onStreamDrift`:
//   the run's unreadable lines reached `STREAM_DRIFT_LINES`, or a turn end's usage cannot be read)
//   stops the worker and parks the story `worker-failed`, the detail naming
//   the worker's version and the count. It decides in event order, so a drift ahead of a turn wins
//   over that turn's report.
// - `daemon.stop { stopWorkers: true }` (0006 decision 7, DIPO-315, `stopAll`): every tracked run
//   nothing was decided for yet is stopped as `story.park` stops one, and parks `by-maintainer` with
//   `DAEMON_STOPPED_DETAIL`; the drain waits for the parks and for the workers' exits.
//
// - `work.steer` (DIPO-163, `intervene.ts`): the maintainer's message to a live worker.
//
// - Notes (0020 section 6, DIPO-154). The `notes` of every turn report are stored for the next
//   session's handoff (`recordWorkerNotes`), keyed by the run's branch and the agent, replacing
//   that agent's earlier notes. A park keeps them, so a cap that fires mid-turn still leaves the
//   previous turn's notes; teardown deletes them.
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
  type RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit, IngestHooks, StreamDriftCount } from "../ingest/ingestor";
import { background } from "../platform/background";
import { recordWorkerNotes } from "../prompts/notes";
import type { WorkerEvent, WorkerReport } from "../workers/types";

import {
  type CapName,
  type FiredCap,
  firedCap,
  REVIEWER_ROLE,
  reviewTotals,
  runCaps,
  runTotals,
  type StreamDriftFacts,
  streamDriftDetail,
} from "./caps";
import { blockedHandOff } from "./conflicts";
import { capDetail, capEnding, reviewCapEnding, RunEndings } from "./control-endings";
import { ReconcileStops } from "./control-reconcile";
import {
  CAP_TICK_MS,
  DAEMON_STOPPED_DETAIL,
  disarm,
  EVENT_FILE_CHANGED,
  messageOf,
  type ReconcileNotice,
  type RunControlDeps,
  type RunEnding,
  type ParkRunArgs,
  type ParkRunResult,
  type Tracked,
  type TrackedRun,
  viewOf,
} from "./control-types";
import { AfterTurns } from "./control-turns";
import { type FeedbackSource, notSentNotice, sendFeedback } from "./feedback";
import { Interventions } from "./intervene";
import { outcomeOfIntent, resolveIntent } from "./intents";
import { initRejectedEnding, type RunAct, type RunEnder, startRefusedAct } from "./outcome-types";
import type { RunEnd } from "./lifecycle";
import { type ParkOutcome } from "./park";
import { findRun, type StoredRun } from "./records";
import { storeProposals } from "./report-data";

export {
  CAP_TICK_MS,
  CONTROL_NOTICES,
  DAEMON_STOPPED_DETAIL,
  EVENT_FILE_CHANGED,
  STORY_NOT_RUNNING,
} from "./control-types";
export type {
  ReconcileNotice,
  RunControlDeps,
  RunEnding,
  RunSteering,
  TrackedRun,
} from "./control-types";

/** How long `stopAll` waits for the stopped workers to exit: past the host's SIGKILL at 30 s. */
export const STOP_ALL_EXIT_WAIT_MS = 45_000;
/** How often `stopAll` looks whether the stopped workers exited. */
const STOP_ALL_POLL_MS = 250;

/** What `stopAll` did, for the drain's log line. */
export interface StopAllResult {
  /** Live workers it stopped. */
  readonly stopped: number;
  /** Runs already being decided (a cap, a report, a done path), whose decision it awaited. */
  readonly deciding: number;
  /** Workers of those runs still running when it stopped waiting. */
  readonly running: number;
}

export class RunControl implements RunEnder {
  readonly #deps: RunControlDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #inflight = new Set<Promise<unknown>>();
  /** Events at which a cap was reached, as of that event inside its pass (`onEventApplied`). */
  readonly #crossings = new WeakMap<WorkerEvent, FiredCap>();
  /** Stream drift events that decide, as the pass counted them (`onStreamDrift`, DIPO-315). */
  readonly #drifts = new WeakMap<WorkerEvent, StreamDriftFacts>();
  readonly #endings: RunEndings;
  readonly #turns: AfterTurns;
  readonly #reconcile: ReconcileStops;
  readonly #interventions: Interventions;

  constructor(deps: RunControlDeps) {
    this.#deps = deps;
    this.#endings = new RunEndings(deps, this.#tracked, this.#inflight);
    this.#turns = new AfterTurns(deps, this.#endings, this.#inflight);
    this.#reconcile = new ReconcileStops(deps, this.#tracked, this.#endings);
    this.#interventions = new Interventions(deps);
  }

  /** The ingestion hooks: caps and reports after every committed pass, intents at the exit. */
  get hooks(): IngestHooks {
    return {
      onEventApplied: (run, _agent, event) => this.onEventApplied(run, event),
      onStreamDrift: (_run, _agent, event, count) => this.#noteDrift(event, count),
      onWorkerEvents: (run, agent, events) => this.onWorkerEvents(run, events, agent),
      onInitRejected: (run, _agent, reason) => this.#initRejected(run, reason),
      onEnded: (run, agent, end) => this.onEnded(run, agent, end),
      onFileChanged: (report) => this.#fileChanged(report.run),
    };
  }

  /**
   * The run's host event file changed (0007 section 5, DIPO-45's `ingest.fileChanged`): its
   * ingestion stopped, so the worker is stopped and the story parks `worker-failed` with the
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
      reason: "worker-failed",
      detail: EVENT_FILE_CHANGED,
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

  /**
   * The events of one committed ingestion pass, in order. `agent` is the session's agent; without
   * it a blocked report's question parks at once.
   */
  onWorkerEvents(run: string, events: readonly WorkerEvent[], agent?: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    const outcomes = this.#deps.outcomes?.();
    // A crossing at a usage event that a done turn of the same pass follows belongs to that turn.
    let pending: FiredCap | null = null;
    for (const [index, event] of events.entries()) {
      if (tracked.ending !== null) return;
      // The worker's stream cannot be read, so its caps are blind (DIPO-315); a done turn that
      // already took the done path keeps it.
      const drift = this.#drifts.get(event);
      if (drift !== undefined && tracked.capped === null) {
        this.#endings.begin(tracked, {
          intent: "park",
          ops: this.#deps.encode({ kind: "stop" }),
          reason: "worker-failed",
          detail: streamDriftDetail(drift),
        });
        return;
      }
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
        // The office's starts pause and the story parks until the reset (0020).
        outcomes.onPlanLimit(viewOf(tracked), {
          credits: event.creditsRequired === true,
          ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
        });
        return;
      }
      if (event.t === "modelSwitched") outcomes?.onModelSwitched(viewOf(tracked), event.to);
      if (event.t === "turn" && (event.report?.proposals?.length ?? 0) > 0) {
        this.#storeProposals(tracked, event.report as WorkerReport);
      }
      if (event.t === "turn") {
        // A done report on the turn that crosses a cap takes the done path (0008 amendment of
        // 2026-10-19, DIPO-205); without a finisher nothing could commit it, so the cap parks.
        const crossed =
          tracked.capped !== null || this.#deps.finisher === undefined
            ? null
            : event.capped !== undefined
              ? { cap: "maxTurns" as const, detail: capDetail("maxTurns", event.capped) }
              : (this.#crossings.get(event) ?? pending);
        if (event.report !== null) this.#keepNotes(tracked, event.report, agent);
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
        // A question asked live: the worker waits on stdin for the answer, so nothing of this turn
        // decides (DIPO-272).
        const live = report?.status === "blocked" && this.#askLive(tracked, report, agent);
        if (report?.status === "blocked" && !live) {
          // A blocked report during a conflict hand-off fails it (0019 section 10, DIPO-149); the
          // failure that reaches the conflict cap parks `conflict` instead.
          const handOff = this.#blockedHandOff(tracked);
          if (handOff !== null) {
            this.#endings.begin(tracked, {
              intent: "park",
              ops: [{ closeStdin: true }],
              ...handOff,
            });
            return;
          }
          this.#endings.begin(tracked, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason: "ambiguous-spec",
            detail: report.question ?? report.summary,
            // The park asks the question when no live one carries over (DIPO-159).
            ...(report.question !== undefined ? { question: report.question } : {}),
          });
          return;
        }
        // The backstop, and verify and commit at `done` (DIPO-49), after the pass, in turn order;
        // then the turn's problem, if any (DIPO-51), or a reviewer's valid report (DIPO-219).
        const problem = outcomes === undefined ? undefined : event.problem;
        const review = outcomes === undefined ? undefined : event.review;
        if (
          !live &&
          (this.#deps.finisher !== undefined || problem !== undefined || review !== undefined)
        ) {
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

  /** Inside a pass: remembers a deciding stream drift, acted on after the commit (DIPO-315). */
  #noteDrift(event: Extract<WorkerEvent, { t: "streamDrift" }>, count: StreamDriftCount): void {
    this.#drifts.set(event, {
      usage: event.kind === "usage",
      worker: event.worker,
      detail: event.detail,
      lines: count.lines,
      threshold: count.threshold,
    });
  }

  /**
   * `daemon.stop { stopWorkers: true }` (0006 decision 7, DIPO-315): stops every live worker this
   * control tracks, as `story.park` stops one (the stop sequence through its host, a `stop` intent
   * first, the story parked `by-maintainer` with `DAEMON_STOPPED_DETAIL`). A run already being decided (a cap, a report, a done path) keeps that decision. Resolves
   * once every decision finished and the stopped workers exited, or `exitWaitMs` after the stops
   * were sent with the ones still running counted; the drain's cap bounds it too.
   */
  async stopAll(exitWaitMs = STOP_ALL_EXIT_WAIT_MS): Promise<StopAllResult> {
    const all = [...this.#tracked.values()];
    let stopped = 0;
    for (const tracked of all) {
      if (tracked.ending !== null) continue;
      this.#endings.begin(tracked, {
        intent: "stop",
        ops: this.#deps.encode({ kind: "stop" }),
        reason: "by-maintainer",
        detail: DAEMON_STOPPED_DETAIL,
      });
      if (tracked.ending !== null) stopped += 1;
    }
    await Promise.allSettled(all.map((tracked) => tracked.ending ?? Promise.resolve(null)));
    // The host sends SIGTERM 10 s after the stop and SIGKILL after 30 s; each exit is ingested and
    // decided before its run is untracked.
    const clock = this.#deps.clock;
    const until = clock.now() + exitWaitMs;
    const running = () => all.filter((tracked) => this.#tracked.get(tracked.runId) === tracked);
    while (running().length > 0 && clock.now() < until) {
      await new Promise<void>((resolve) => clock.setTimeout(resolve, STOP_ALL_POLL_MS));
    }
    await this.idle();
    return { stopped, deciding: all.length - stopped, running: running().length };
  }

  /**
   * A blocked report while a conflict hand-off is open (DIPO-149): the hand-off fails, and the park
   * that replaces the blocked one when that failure reaches the run's conflict cap, else null.
   */
  #blockedHandOff(tracked: Tracked): ReturnType<typeof blockedHandOff> {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return null;
    try {
      return office.immediate(() => blockedHandOff(office, tracked.runId, this.#deps.clock.now()));
    } catch (error) {
      this.#deps.warn?.("recording a failed conflict hand-off failed", {
        run: tracked.runId,
        reason: messageOf(error),
      });
      return null;
    }
  }

  /**
   * Stores a report's proposals (DIPO-186); a failure is logged and decides nothing, since the
   * proposals change nothing about the run.
   */
  #storeProposals(tracked: Tracked, report: WorkerReport): void {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    try {
      const filed = office.immediate(() =>
        storeProposals(office, {
          key: tracked.work.key,
          runId: tracked.runId,
          proposals: report.proposals ?? [],
          at: this.#deps.clock.now(),
        }),
      );
      // Each stored proposal appended its `proposal.filed` (DIPO-166).
      if (filed > 0) this.#deps.onChanged?.(tracked.office);
    } catch (error) {
      this.#deps.warn?.("storing a report's proposals failed", {
        run: tracked.runId,
        reason: messageOf(error),
      });
    }
  }

  /**
   * A blocked report's question through the live-question rule (DIPO-272): true when it was asked
   * live. A report without a question or a run without its agent parks.
   */
  #askLive(tracked: Tracked, report: WorkerReport, agent: string | undefined): boolean {
    if (report.question === undefined) return false;
    if (agent === undefined) return false;
    const office = this.#deps.offices.get(tracked.office);
    const questions = this.#deps.questions?.();
    if (office === undefined || questions === undefined) return false;
    return questions.askWorker(office, tracked.runId, agent, report.question);
  }

  /**
   * Stores the notes of a developer's turn report for the next session's handoff (0020 section 6),
   * replacing that agent's earlier notes on the run's branch. A report without notes changes
   * nothing, so the previous turn's notes stay. A failed write is logged; the turn goes on.
   */
  #keepNotes(tracked: Tracked, report: WorkerReport, agent: string | undefined): void {
    if (report.notes === undefined || tracked.work.role === REVIEWER_ROLE) return;
    const office = this.#deps.offices.get(tracked.office);
    const branch = office === undefined ? null : findRun(office, tracked.runId)?.branch;
    if (office === undefined || branch == null) return;
    try {
      recordWorkerNotes(
        office,
        {
          branch,
          run: tracked.runId,
          agent: agent ?? tracked.work.agent,
          role: tracked.work.role,
          storyKey: tracked.work.key,
          notes: report.notes,
        },
        this.#deps.clock,
      );
    } catch (error) {
      this.#deps.warn?.("storing the worker's notes failed", {
        run: tracked.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parks the run `ambiguous-spec` with its worker's question once the question stopped being live
   * (the last TUI closed, DIPO-284, or its wait of `timeouts.questionWaitMinutes` ended, DIPO-159):
   * stdin closes, as at a blocked report, and the park carries the question, still open. False when
   * the run is not tracked here or already being ended.
   */
  parkOnQuestion(run: string, question: string): boolean {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return false;
    this.#endings.begin(tracked, {
      intent: "park",
      ops: [{ closeStdin: true }],
      reason: "ambiguous-spec",
      detail: question,
    });
    return true;
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
   * red verify parks `budget-exceeded`, since no turn is left (`verify-commit.ts`).
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
   * Parks a tracked run while its worker works, outside any turn (DIPO-273: a box part's scan hit
   * or rejected push): the stop sequence is sent, as for `story.park`, and the story parks with
   * `reason` and `detail`. False when another decision came first.
   */
  parkRun(runId: string, park: { readonly reason: ParkReason; readonly detail: string }): boolean {
    return this.begin(runId, {
      intent: "park",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: park.reason,
      detail: park.detail,
    });
  }

  /**
   * Sends `text` to a live run's worker as its next message through the one feedback path
   * (`feedback.ts`; DIPO-277: another story changes the same files, or dipo merged the new base
   * into the story), tagged `source`. False when the run is not live here.
   */
  async tellWorker(runId: string, text: string, source: FeedbackSource): Promise<boolean> {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined || tracked.ending !== null) return false;
    const office = this.#deps.offices.get(tracked.office);
    const run = office === undefined ? null : findRun(office, runId as RunId);
    if (office === undefined || run === null) return false;
    const error = await sendFeedback(office, run.runId, { source, text }, { sender: this.#deps })
      .done;
    if (error !== null) {
      this.#endings.writer(office, tracked.office)(() => [notSentNotice(run, source, error)]);
    }
    return true;
  }

  /**
   * The first decision on a tracked run without a park (a reassign or a start failure): the
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
    this.#endings.begin(tracked, initRejectedEnding(tracked.work.story, reason));
  }

  /** `story.park` of a story with a run: see the file comment. */
  parkByMaintainer(
    ctx: AsyncCommandContext,
    args: ParkRunArgs,
  ): Promise<CommandOutcome<ParkRunResult>> {
    return this.#endings.parkByMaintainer(ctx, args);
  }

  /** True while a decision on the run (a cap, a report, `story.park`) is being carried out. */
  isEnding(run: string): boolean {
    const ending = this.#tracked.get(run)?.ending;
    return ending !== undefined && ending !== null;
  }

  /** Reconcile (DIPO-56, 0007 section 6): stops a run whose story left In Progress or In Review. */
  stopForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    notice: ReconcileNotice,
    ending: RunEnd,
  ): Promise<void> {
    return this.#reconcile.stopForReconcile(office, run, notice, ending);
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

  /** The command `work.steer`. */
  get feature(): FeatureModule {
    const intervene = this.#interventions.feature;
    return {
      name: "run-control",
      register: (registry) => {
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
   * tracked caps serving for a legacy run. A reviewer session (0002) counts its own tokens, turns
   * and minutes against the reviewer's own caps; the developer's caps never count the review.
   */
  #fired(office: OfficeHandle, tracked: Tracked): FiredCap | null {
    const run = findRun(office, tracked.runId);
    if (run === null) return null;
    const caps = runCaps(office, run, tracked.caps);
    const now = this.#deps.clock.now();
    if (reviewing(tracked)) {
      return firedCap(
        {
          budgetTokens: caps.reviewMaxTokens ?? tracked.caps.budgetTokens,
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
