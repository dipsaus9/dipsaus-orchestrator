// Ending a run (DIPO-50, split out of `control.ts` by DIPO-128): the intent and its ops, the park
// that follows, a decision without a park, `story.park` of a story with a run, and the writes they
// share. The reconcile
// stops are in `control-reconcile.ts`.

import type { OfficeId, StoryKey, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { background, failureFields } from "../platform/background";
import { withWorkViews, workRefOf } from "../views/work";

import {
  CONTROL_NOTICES,
  disarm,
  type Ending,
  type RunEnding,
  messageOf,
  type ParkRunArgs,
  type ParkRunResult,
  type RunControlDeps,
  STOP_ALL_EXIT_WAIT_MS,
  STORY_NOT_RUNNING,
  type Tracked,
} from "./control-types";
import type { CapName } from "../records/caps";
import { resolveIntent, sendAsIntent } from "../records/intents";
import { workerHostsOf } from "../records/worker-hosts";
import { HOST_LAUNCH_DEADLINE_MS } from "./hosts";
import type { RunAct } from "./outcome-types";
import {
  openPark,
  openParkIds,
  PARK_NOT_WRITTEN,
  type ParkDeps,
  type ParkOutcome,
  type ParkWriter,
  parkStory,
} from "./park";
import { activeRuns, findRun, openAtInReview, type StoredRun } from "../records/run-records";
import { liveClaimOf } from "../worktree/records";

/** The detail a cap is named with; the CLI backstop's own detail gets the turn cap prefix. */
export function capDetail(cap: CapName, detail: string): string {
  return cap === "maxTurns" && !detail.startsWith("turn cap") ? `turn cap: ${detail}` : detail;
}

/** The ending of a run that reached a cap: the stop sequence and the park `budget-exceeded`. */
export function capEnding(encode: RunControlDeps["encode"], cap: CapName, detail: string): Ending {
  return {
    intent: "cap",
    ops: encode({ kind: "stop" }),
    reason: "budget-exceeded",
    detail: capDetail(cap, detail),
  };
}

/**
 * The ending of a reviewer session that reached one of its own caps (0002): its tokens, turns or
 * minutes per session. It parks `worker-failed`, the detail naming the cap, with no retry; the
 * story's budget is never what a review uses up.
 */
export function reviewCapEnding(
  encode: RunControlDeps["encode"],
  cap: CapName,
  detail: string,
): Ending {
  return {
    intent: "cap",
    ops: encode({ kind: "stop" }),
    reason: "worker-failed",
    detail: `the reviewer's ${capDetail(cap, detail)}`,
  };
}

/** What the endings need of run control's starts (DIPO-411). */
export interface RunStarts {
  /** Arms a tracked run's cap tick again: a maintainer's park that sent nothing leaves it running. */
  readonly rearm: (tracked: Tracked) => void;
  /** Settles once the worker start under way for the run ended; undefined when none is. */
  readonly startOf: (run: string) => Promise<void> | undefined;
}

export class RunEndings {
  readonly #deps: RunControlDeps;
  readonly #tracked: Map<string, Tracked>;
  readonly #inflight: Set<Promise<unknown>>;
  readonly #starts: RunStarts;
  /** Runs a maintainer's park of an unfollowed run is ending now: a worker tracked meanwhile stops. */
  readonly #parking = new Set<string>();

  constructor(
    deps: RunControlDeps,
    tracked: Map<string, Tracked>,
    inflight: Set<Promise<unknown>>,
    starts: RunStarts = { rearm: () => undefined, startOf: () => undefined },
  ) {
    this.#deps = deps;
    this.#tracked = tracked;
    this.#inflight = inflight;
    this.#starts = starts;
  }

  /** True while a maintainer's park of the unfollowed run is ending it (DIPO-411). */
  parking(run: string): boolean {
    return this.#parking.has(run);
  }

  /**
   * The first decision on a tracked run without a park (a reassign or a start failure): the
   * intent is stored, then its ops are sent. Nothing else is decided for the run after it; the
   * worker's exit is decided from the intent. False when a decision was made already, or when
   * the intent could not be stored: then no op is sent and the failure is logged (DIPO-119).
   */
  act(tracked: Tracked, act: RunAct): boolean {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return false;
    let sending: Promise<unknown>;
    try {
      sending = sendAsIntent(office, this.#deps.steering, tracked.runId, {
        kind: act.intent,
        detail: act.detail,
        ops: act.ops,
        clock: this.#deps.clock,
      }).done;
    } catch (error) {
      // 0008: an op is stored as an intent before it is sent, so none is sent. A turn problem's
      // act is tried again at the next cap tick (DIPO-123); a failing unflagged act leaves a
      // waiting one in place.
      if (act.retryAtTick === true) tracked.unstored = act;
      this.#deps.warn?.("storing a run's decision failed", {
        run: tracked.runId,
        intent: act.intent,
        ...failureFields(error),
      });
      return false;
    }
    // The send started inside `sendAsIntent`, but nothing reached the host yet: the steering's
    // first await (`hostSocketSteering` looking up the newest host) comes before any effect, so
    // these synchronous writes land before any op is sent.
    tracked.unstored = null;
    disarm(this.#deps.clock, tracked);
    tracked.deciding = `dipo is still carrying out its ${act.intent} decision on the run`;
    // The intent's sent mark is written in the job; a failure there is logged (DIPO-110).
    tracked.ending = background(
      async () => {
        await sending;
      },
      {
        failed: "sending a run's decision failed",
        fields: { run: tracked.runId, intent: act.intent },
        log: this.#deps.warn,
        inflight: this.#inflight,
      },
    ).then(() => null);
    return true;
  }

  /** Parks a run whose worker exited (a decision at the exit, DIPO-51). */
  park(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: RunEnding,
  ): Promise<ParkOutcome> {
    return this.end(office, run, work, ending, this.writer(office, office.officeId));
  }

  /**
   * `story.park` of a story with a run (0020): the story parks `by-maintainer` with the note as its
   * detail. A running worker is stopped first, as every stop is sent (a `stop` intent, then the
   * stop sequence through the host); a decision already under way (a cap or a report) finishes
   * first, and when it parked the story already the reply says so (`changed: false`). A run that
   * waits In Review with no live session (for its review, a gate or the merge) parks as it is: the
   * park is written on the branch and recorded, and the run ends parked with the end of its last
   * active period kept, so its resume returns it to In Review. A story with no run fails `story.notRunning`.
   *
   * The worker of a run this daemon follows is stopped before anything parks (DIPO-411): the story
   * parks once its exit was ingested, and the reply waits for that up to `STOP_ALL_EXIT_WAIT_MS`. If
   * no exit came by then, a stop that could not be sent parks nothing, and a sent one parks at the
   * exit; both fail the retryable `run.hostAlive` naming what still runs, so `dipo park` never
   * says parked while the run's worker runs.
   */
  async parkByMaintainer(
    ctx: AsyncCommandContext,
    args: ParkRunArgs,
  ): Promise<CommandOutcome<ParkRunResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const find = () =>
      activeRuns(handle).find((run) => run.kind === "story" && run.key === identity.key);
    const story = identity.story;
    const run = await this.#settledRun(handle, find, story);
    const note = args.note.trim();
    if (run === undefined) return await this.#parkWaiting(ctx, identity, note);
    const ending: Ending = {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "by-maintainer",
      detail: note,
    };
    const tracked = this.#tracked.get(run.runId);
    const work = tracked?.work ?? workRefOf(handle, run.runId) ?? undefined;
    const commit = (fn: () => readonly NewEntry[]) => ctx.commit(fn);
    const parked =
      tracked === undefined
        ? await this.#parkUnfollowed(handle, run, work, ending, commit, story)
        : await this.#stopThenPark(handle, run, tracked, work, ending, commit, story);
    // A tampered worktree turned it into a `scope-violation` park, which a retry cannot write.
    if (!parked.written && parked.reason === ending.reason) {
      // The worker was stopped, so the run ended and its park is recorded as held, unwritten
      // (`heldByPark`, the desk's PARK NOT WRITTEN): the place frees, and nothing starts it again.
      // `story.park` once more writes it on the same row (DIPO-360).
      throw new CommandError(
        PARK_NOT_WRITTEN,
        `dipo stopped ${identity.story}'s worker, but could not write its park to Backlog.md (${parked.writeError ?? "unknown error"}); its work is held. Send the park again to write it.`,
        { story: identity.story, run: run.runId },
      );
    }
    return { result: { run: run.runId } };
  }

  /**
   * The story's active run once what is under way for it settled, or undefined when it ended. A
   * worker being started is waited for (DIPO-411), up to its launch deadline, so the park stops it
   * once it is followed instead of parking while it starts. A decision already under way (a cap, a
   * report, an earlier park) finishes first; a park waiting for its worker's exit is waited for as
   * long as a park waits. Either still under way fails `run.hostAlive` saying what it is.
   */
  async #settledRun(
    handle: OfficeHandle,
    find: () => StoredRun | undefined,
    story: string,
  ): Promise<StoredRun | undefined> {
    let run = find();
    const start =
      run === undefined || this.#tracked.has(run.runId)
        ? undefined
        : this.#starts.startOf(run.runId);
    if (run !== undefined && start !== undefined) {
      if (!(await this.#within(start, HOST_LAUNCH_DEADLINE_MS))) {
        throw this.#stillRuns(handle, run, story, "dipo is still starting its worker");
      }
      run = find();
    }
    const earlier = run === undefined ? undefined : this.#tracked.get(run.runId);
    const pending = earlier?.ending;
    if (run === undefined || earlier === undefined || pending == null) return run;
    if (!(await this.#within(pending, STOP_ALL_EXIT_WAIT_MS))) {
      const what = earlier.deciding ?? "dipo is still carrying out a decision on the run";
      throw this.#stillRuns(handle, run, story, what);
    }
    return find();
  }

  /**
   * The maintainer's park of an active run no worker of which is followed or being started here
   * (DIPO-411): one waiting for its place, between sessions, or open at In Review with none.
   * Nothing runs, so nothing is sent; a worker host row of it still open means a worker may run
   * unfollowed, and nothing parks then (fail closed). While it parks, a worker tracked for the run
   * is stopped at once (`RunControl.track`).
   */
  async #parkUnfollowed(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: Ending,
    commit: (fn: () => readonly NewEntry[]) => void,
    story: string,
  ): Promise<ParkOutcome> {
    if (workerHostsOf(office, run.runId).some((host) => host.endedAt === null)) {
      throw this.#stillRuns(office, run, story, "dipo does not follow the worker of its run");
    }
    this.#parking.add(run.runId);
    try {
      return await this.end(office, run, work, { ...ending, ops: [] }, commit);
    } finally {
      this.#parking.delete(run.runId);
    }
  }

  /**
   * The maintainer's park of a run this daemon follows (DIPO-411): the stop is sent (its sends wait
   * for a host that is still starting, `hostSocketSteering`), then the story parks once the
   * worker's exit was ingested. A stop that could not be sent parks only when the exit still comes
   * within `STOP_ALL_EXIT_WAIT_MS` (its host had exited); otherwise it leaves the run as it was,
   * its intent resolved `notSent` so it explains no later exit, and fails. A sent stop whose worker
   * has not exited within that wait fails the reply, and its story parks at the exit.
   */
  async #stopThenPark(
    office: OfficeHandle,
    run: StoredRun,
    tracked: Tracked,
    work: WorkRef | undefined,
    ending: Ending,
    commit: (fn: () => readonly NewEntry[]) => void,
    story: string,
  ): Promise<ParkOutcome> {
    disarm(this.#deps.clock, tracked);
    const write = (fn: () => readonly NewEntry[]): void =>
      commit(() => withWorkViews(office, fn()));
    const sent = this.#send(office, run, ending, write);
    const decision = sent.done.then(async ({ error }) => {
      // A stop that was not sent may have met a host that exited already: its exit comes in soon.
      if (error !== null && !(await this.#within(tracked.exited, STOP_ALL_EXIT_WAIT_MS))) {
        const at = this.#deps.clock.now();
        office.immediate(() => resolveIntent(office, run.runId, sent.intentId, "notSent", at));
        tracked.ending = null;
        this.#starts.rearm(tracked);
        return null;
      }
      await tracked.exited;
      return this.#parkAfterStop(
        office,
        run,
        work,
        { ...ending, report: tracked.lastReport },
        write,
      );
    });
    tracked.ending = decision;
    tracked.deciding = "dipo sent its worker the stop of an earlier park";
    // A park that outlives the reply (its worker exits later) logs its own failure.
    decision.catch((thrown: unknown) => {
      this.#deps.warn?.("parking a run failed", { run: run.runId, reason: messageOf(thrown) });
    });
    const { error } = await sent.done;
    if (error !== null) {
      const parked = await decision;
      if (parked !== null) return parked;
      throw this.#stillRuns(
        office,
        run,
        story,
        `dipo could not send its worker the stop (${error})`,
      );
    }
    if (!(await this.#within(tracked.exited, STOP_ALL_EXIT_WAIT_MS))) {
      throw this.#stillRuns(office, run, story, "dipo sent its worker the stop");
    }
    const parked = await decision;
    if (parked === null) throw new Error(`${story}'s park sent its stop, yet parked nothing`);
    return parked;
  }

  /**
   * `run.hostAlive` for a park whose worker did not exit (DIPO-411): `what` dipo did, and the
   * worker host of the run that has not exited, by its PID.
   */
  #stillRuns(office: OfficeHandle, run: StoredRun, story: string, what: string): CommandError {
    const host = workerHostsOf(office, run.runId).at(-1);
    const pid = host === undefined || host.pending ? "" : ` (pid ${host.pid})`;
    const waits = this.#tracked.get(run.runId)?.ending != null;
    return new CommandError(
      "run.hostAlive",
      `${what}; its worker has not exited, so its worker host${pid} and its worker still run and ${story} is not parked yet. ${waits ? "It parks once its worker exits." : `Send \`dipo park ${story} --note <why>\` again in a moment.`}`,
      { story, run: run.runId, ...(host === undefined || host.pending ? {} : { pid: host.pid }) },
    );
  }

  /** True when `promise` settles within `ms` on the engine clock, else false. */
  #within(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const clock = this.#deps.clock;
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => resolve(false), ms);
      const settled = () => {
        clock.clearTimeout(timer);
        resolve(true);
      };
      promise.then(settled, settled);
    });
  }

  /**
   * `story.park` of a story whose run waits (In Review, or stopped with an unwritten park): nothing
   * runs, so nothing is stopped, and a park whose write fails records nothing (DIPO-360).
   */
  async #parkWaiting(
    ctx: AsyncCommandContext,
    identity: { readonly story: string; readonly key: StoryKey },
    note: string,
  ): Promise<CommandOutcome<ParkRunResult>> {
    const handle = ctx.office;
    const claim = liveClaimOf(handle, identity.key);
    const waiting = claim === null ? null : findRun(handle, claim.runId);
    if (waiting === null || waiting.kind !== "story") {
      throw new CommandError(STORY_NOT_RUNNING, `${identity.story} has no run to park.`, {
        story: identity.story,
      });
    }
    if (openPark(this.#deps.stories, handle, identity.key) !== null) {
      return { result: { run: waiting.runId }, changed: false };
    }
    // A park of this run that Backlog.md does not hold (its write failed) is written again on
    // its row (DIPO-360).
    const unwritten = openParkIds(handle, identity.key, waiting.runId).at(-1);
    // Only a run that waits In Review (for its review, a gate or the merge) parks as it is.
    if (unwritten === undefined && !openAtInReview(waiting)) {
      throw new CommandError(STORY_NOT_RUNNING, `${identity.story} has no run to park.`, {
        story: identity.story,
      });
    }
    await parkStory(
      this.#parkDeps(handle, (fn) => ctx.commit(() => withWorkViews(handle, fn()))),
      {
        run: waiting,
        reason: "by-maintainer",
        detail: note,
        mustWrite: true,
        ...(unwritten === undefined ? {} : { parkId: unwritten }),
      },
    );
    await this.refresh(handle, waiting, "parked");
    return { result: { run: waiting.runId } };
  }

  // ---- ending a run ----------------------------------------------------------------------------

  /** The first decision on a tracked run, outside any command. */
  begin(tracked: Tracked, ending: Ending): void {
    disarm(this.#deps.clock, tracked);
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
    const done = this.end(office, run, tracked.work, ending, write);
    tracked.ending = done;
    tracked.deciding = `dipo is still ending its run: a ${ending.intent} that parks it ${ending.reason}`;
    background(() => done, {
      failed: "parking a run failed",
      fields: { run: tracked.runId },
      log: this.#deps.warn,
      inflight: this.#inflight,
    });
  }

  /**
   * Records the intent (synchronously, before the first await), sends its ops through the host and
   * parks the story. A send that fails leaves the intent `failed` and puts a notice on the office;
   * the park still happens. Every entry it writes carries the run's work view where its type has
   * one (DIPO-52's `withWorkViews`), derived in the transaction that wrote the facts.
   */
  end(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: Ending & { readonly capStep?: string },
    commit: (fn: () => readonly NewEntry[]) => void,
    writer: ParkWriter = this.#deps.writer,
  ): Promise<ParkOutcome> {
    const write = (fn: () => readonly NewEntry[]): void =>
      commit(() => withWorkViews(office, fn()));
    const { done } = this.#send(office, run, ending, write);
    return (async () => {
      const { error } = await done;
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
      return this.#parkAfterStop(office, run, work, ending, write, writer);
    })();
  }

  /** Records the ending's intent (synchronously, before the first await) and sends its ops. */
  #send(
    office: OfficeHandle,
    run: StoredRun,
    ending: Ending,
    write: (fn: () => readonly NewEntry[]) => void,
  ): ReturnType<typeof sendAsIntent> {
    const notice = ending.notice;
    return sendAsIntent(office, this.#deps.steering, run.runId, {
      kind: ending.intent,
      detail: ending.intentDetail ?? ending.detail,
      ops: ending.ops,
      clock: this.#deps.clock,
      beforeSend: () => {
        if (notice === undefined) return;
        write(() => [
          {
            type: "engine.notice",
            ...(run.key === null ? {} : { key: run.key }),
            run: run.runId,
            delta: notice,
          },
        ]);
      },
    });
  }

  /** The park after the stop was sent: the story parks, the run summary, the branch read again. */
  async #parkAfterStop(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: Ending & { readonly capStep?: string },
    write: (fn: () => readonly NewEntry[]) => void,
    writer: ParkWriter = this.#deps.writer,
  ): Promise<ParkOutcome> {
    this.#deps.flushOutput?.(office.officeId, run.runId);
    const parked = await parkStory(this.#parkDeps(office, write, writer), {
      run,
      ...(work === undefined ? {} : { work }),
      reason: ending.reason,
      detail: ending.detail,
      ...(ending.capStep === undefined ? {} : { capStep: ending.capStep }),
      ...(ending.question === undefined ? {} : { question: ending.question }),
      ...(ending.mustWrite === true ? { mustWrite: true } : {}),
      ...(ending.resumeOnLift === true ? { resumeOnLift: true } : {}),
    });
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
    if (writer === this.#deps.writer) await this.refresh(office, run, "parked");
    // A park to resume when the starts paused lifts may land while they are not paused (0020).
    if (ending.resumeOnLift === true) this.#deps.parkedToResume?.(office.officeId as OfficeId);
    return parked;
  }

  /**
   * Reads the run's story again at its branch tip after a status commit there (DIPO-56), so the
   * story view and snapshots read the new status at once. A read that fails is logged; the next
   * index pass reads it.
   */
  async refresh(office: OfficeHandle, run: StoredRun, what: string): Promise<void> {
    if (run.key === null || this.#deps.refreshStory === undefined) return;
    await this.#deps.refreshStory(office.officeId, run.key).catch((thrown: unknown) => {
      this.#deps.warn?.(`reading the ${what} story again failed`, {
        run: run.runId,
        reason: messageOf(thrown),
      });
    });
  }

  /** What `parkStory` needs: an `ambiguous-spec` park asks its question with a new id. */
  #parkDeps(
    office: OfficeHandle,
    write: (fn: () => readonly NewEntry[]) => void,
    writer: ParkWriter = this.#deps.writer,
  ): ParkDeps {
    const ids = this.#deps.ids;
    return {
      office,
      writer,
      now: () => this.#deps.clock.now(),
      write,
      implemented: this.#deps.implemented ?? (() => false),
      ...(ids === undefined ? {} : { question: { id: () => ids.next("qst") } }),
    };
  }

  /** Writes entries outside a command: one transaction, then subscribers are told. */
  writer(office: OfficeHandle, officeId: OfficeId): (fn: () => readonly NewEntry[]) => void {
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
