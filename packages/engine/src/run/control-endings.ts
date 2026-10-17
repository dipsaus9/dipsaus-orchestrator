// Ending a run (DIPO-50, split out of `control.ts` by DIPO-128): the intent and its ops, the park
// that follows, a decision without a park, `work.stop`, the reconcile stops and the writes they
// share.

import type { OfficeId, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { background, failureFields } from "../platform/background";
import { withWorkViews, workRefOf } from "../views/work";
import type { WorkerReport } from "../workers/types";

import {
  CONTROL_NOTICES,
  disarm,
  type Ending,
  type RunEnding,
  messageOf,
  noticeEntry,
  RECONCILED_END,
  type ReconcileNotice,
  type RunControlDeps,
  STOPPED_DETAIL,
  STORY_NOT_RUNNING,
  type StopArgs,
  type StopResult,
  type Tracked,
} from "./control-types";
import { sendAsIntent } from "./intents";
import { endRunMarked } from "./markers";
import type { RunAct } from "./outcome-types";
import { type ParkDeps, type ParkOutcome, type ParkWriter, parkStory } from "./park";
import { activeRuns, findRun, type StoredRun } from "./records";

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
   * The first decision on a tracked run without a park (a reassign or a plan-limit hold): the
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
    if (tracked !== undefined) disarm(this.#deps.clock, tracked);
    const done = this.end(handle, run, work, ending, (fn) => ctx.commit(fn));
    if (tracked !== undefined) tracked.ending = done;
    await done;
    return { result: { run: run.runId } };
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
      disarm(this.#deps.clock, tracked);
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
    const { done } = sendAsIntent(office, this.#deps.steering, run.runId, {
      kind: "stop",
      detail: notice.text,
      ops: this.#deps.encode({ kind: "stop" }),
      clock: this.#deps.clock,
      inMark: (_error, at) => this.#endReconciled(office, run, notice, endKind, at),
    });
    const appended = (await done).marked ?? 0;
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    // The run summary (DIPO-49), as for every run that ends here.
    await this.#deps.finisher?.summarize(office, run, lastReport).catch((thrown: unknown) => {
      this.#deps.warn?.("storing the run summary failed", {
        run: run.runId,
        reason: messageOf(thrown),
      });
    });
  }

  /** The end of a reconciled run, in the transaction that marks its stop intent. */
  #endReconciled(
    office: OfficeHandle,
    run: StoredRun,
    notice: ReconcileNotice,
    endKind: string,
    at: number,
  ): number {
    endRunMarked(office, run.runId, at, endKind);
    office.run(
      `update agents set end_reason = coalesce(end_reason, $kind)
       where office_id = $office_id and run_id = $run and ended_at is null`,
      { kind: endKind, run: run.runId },
    );
    const entries = withWorkViews(office, [noticeEntry(run, notice)]);
    appendEntries(office, entries, { at });
    return entries.length;
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
    if (tracked !== undefined) disarm(this.#deps.clock, tracked);
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
    const done = this.end(
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
    ending: Ending,
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
      const parked = await parkStory(
        {
          office,
          writer,
          now: () => this.#deps.clock.now(),
          write,
          implemented: this.#deps.implemented ?? (() => false),
          ...this.#parkQuestion(office.officeId),
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
      if (writer === this.#deps.writer) await this.refresh(office, run, "parked");
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

  /** Sends a verify feedback item as the next user message, stored first as a `steer` intent. */
  async sendFeedback(
    office: OfficeHandle,
    run: StoredRun,
    text: string,
    write: (fn: () => readonly NewEntry[]) => void,
  ): Promise<void> {
    const { done } = sendAsIntent(office, this.#deps.steering, run.runId, {
      kind: "steer",
      detail: "verify feedback",
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
            text: `${run.story ?? run.runId}: dipo could not send the verify feedback to its worker (${error}).`,
          },
        },
      ]);
    }
  }

  /** What a `needs-permission` park needs to ask its question (DIPO-75); nothing without ids. */
  #parkQuestion(officeId: OfficeId): Pick<ParkDeps, "question"> {
    const ids = this.#deps.ids;
    if (ids === undefined) return {};
    const config = this.#deps.offices.config?.(officeId);
    return {
      question: {
        id: () => ids.next("qst"),
        allowedDomains: config?.sandbox.allowedDomains ?? [],
      },
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
