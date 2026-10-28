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
  STORY_NOT_RUNNING,
  type Tracked,
} from "./control-types";
import type { CapName } from "./caps";
import { sendAsIntent } from "./intents";
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
import { activeRuns, findRun, IN_REVIEW_END, REVIEWED_END, type StoredRun } from "./records";
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
    endKind: "capped",
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
    endKind: "capped",
  };
}

export class RunEndings {
  readonly #deps: RunControlDeps;
  readonly #tracked: Map<string, Tracked>;
  readonly #inflight: Set<Promise<unknown>>;

  constructor(
    deps: RunControlDeps,
    tracked: Map<string, Tracked>,
    inflight: Set<Promise<unknown>>,
  ) {
    this.#deps = deps;
    this.#tracked = tracked;
    this.#inflight = inflight;
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
   * park is written on the branch and recorded, and the run keeps its end kind, so its resume
   * returns it to In Review. A story with no run fails `story.notRunning`.
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
    let run = find();
    // A decision already under way (a cap or a report) finishes first; then the run has ended.
    const pending = run === undefined ? undefined : this.#tracked.get(run.runId)?.ending;
    if (pending !== undefined && pending !== null) {
      await pending.catch(() => null);
      run = find();
    }
    const note = args.note.trim();
    if (run === undefined) return await this.#parkWaiting(ctx, identity, note);
    const ending: Ending = {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "by-maintainer",
      detail: note,
      endKind: "stopped",
    };
    const tracked = this.#tracked.get(run.runId);
    const work = tracked?.work ?? workRefOf(handle, run.runId) ?? undefined;
    if (tracked !== undefined) disarm(this.#deps.clock, tracked);
    const done = this.end(handle, run, work, ending, (fn) => ctx.commit(fn));
    if (tracked !== undefined) tracked.ending = done;
    const parked = await done;
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
    if (openPark(handle, identity.key) !== null) {
      return { result: { run: waiting.runId }, changed: false };
    }
    // A park of this run that Backlog.md does not hold (its write failed) is written again on
    // its row (DIPO-360).
    const unwritten = openParkIds(handle, identity.key, waiting.runId).at(-1);
    // Only a run that waits In Review (for its review, a gate or the merge) parks as it is.
    if (
      unwritten === undefined &&
      waiting.endKind !== IN_REVIEW_END &&
      waiting.endKind !== REVIEWED_END
    ) {
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
        endKind: "stopped",
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
    const notice = ending.notice;
    const { done } = sendAsIntent(office, this.#deps.steering, run.runId, {
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
    return (async () => {
      const { error, via } = await done;
      const signalled = via === "signal";
      if (signalled) {
        // A follow-only host got one SIGTERM after its PID and start time were verified (DIPO-93).
        write(() => [
          {
            type: "engine.notice",
            ...(run.key === null ? {} : { key: run.key }),
            run: run.runId,
            delta: {
              level: "info",
              code: CONTROL_NOTICES.stopSignalled,
              text: `${run.story ?? run.runId}: its worker host is followed only, so dipo sent it SIGTERM after checking its PID and start time; the host stops the worker and dipo follows it until it exits.`,
            },
          },
        ]);
      }
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
      const parked = await parkStory(this.#parkDeps(office, write, writer), {
        run,
        ...(work === undefined ? {} : { work }),
        reason: ending.reason,
        detail: ending.detail,
        endKind: ending.endKind,
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
    })();
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

  /**
   * Sends a verify feedback item as the next user message, stored first as a `steer` intent.
   * `what` names the message in its intent and in the notice when it did not reach the worker
   * (DIPO-277 sends the collision messages this way).
   */
  async sendFeedback(
    office: OfficeHandle,
    run: StoredRun,
    text: string,
    write: (fn: () => readonly NewEntry[]) => void,
    what = "verify feedback",
  ): Promise<void> {
    const { done } = sendAsIntent(office, this.#deps.steering, run.runId, {
      kind: "steer",
      detail: what,
      ops: this.#deps.encode({ kind: "steer", text }),
      clock: this.#deps.clock,
    });
    const { error } = await done;
    if (error !== null) {
      write(() => [
        {
          type: "engine.notice",
          ...(run.key === null ? {} : { key: run.key }),
          run: run.runId,
          delta: {
            level: "warn",
            code: CONTROL_NOTICES.feedbackNotSent,
            text: `${run.story ?? run.runId}: dipo could not send the ${what} to its worker (${error}).`,
          },
        },
      ]);
    }
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
