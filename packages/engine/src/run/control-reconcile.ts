// The reconcile stops of run control (DIPO-56, split out of `control-endings.ts` by DIPO-128): a
// run whose story left In Progress or In Review is stopped without a park, and a run whose
// worktree or branch changed by hand parks `scope-violation`.

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { presetEndReasons } from "../records/agents";
import { withWorkViews, workRefOf } from "../views/work";
import type { WorkerReport } from "../workers/types";

import type { RunEndings } from "./control-endings";
import {
  disarm,
  messageOf,
  noticeEntry,
  RECONCILE_STOP_REASON,
  type ReconcileNotice,
  type RunControlDeps,
  type Tracked,
} from "./control-types";
import { sendAsIntent } from "../records/intents";
import type { RunEnd } from "../records/lifecycle";
import { endRunMarked } from "./markers";
import { type ParkOutcome } from "./park";
import type { StoredRun } from "../records/run-records";

export class ReconcileStops {
  readonly #deps: RunControlDeps;
  readonly #tracked: Map<string, Tracked>;
  readonly #endings: RunEndings;

  constructor(deps: RunControlDeps, tracked: Map<string, Tracked>, endings: RunEndings) {
    this.#deps = deps;
    this.#tracked = tracked;
    this.#endings = endings;
  }

  /**
   * Reconcile (DIPO-56, 0007 section 6): the run is active in the database, but its story's
   * status is no longer In Progress or In Review, or the story was removed. The engine records a
   * `stop` intent, sends the stop sequence to its worker host if one still answers, and ends the
   * run as `ending` (its story's status decides, `reconciledEnding`), together with `notice`, in
   * one transaction. dipo writes no park: the story's status already says where it is.
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
    ending: RunEnd,
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
      await this.#stopForReconcile(office, run, notice, ending, tracked?.lastReport ?? null);
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
    ending: RunEnd,
    lastReport: WorkerReport | null,
  ): Promise<void> {
    const { done } = sendAsIntent(office, this.#deps.steering, run.runId, {
      kind: "stop",
      detail: notice.text,
      ops: this.#deps.encode({ kind: "stop" }),
      clock: this.#deps.clock,
      inMark: (_error, at) => this.#endReconciled(office, run, notice, ending, at),
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
    ending: RunEnd,
    at: number,
  ): number {
    endRunMarked(office, run.runId, at, ending);
    presetEndReasons(office, run.runId, RECONCILE_STOP_REASON);
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
    const done = this.#endings.end(
      office,
      run,
      work,
      {
        intent: "stop",
        ops: this.#deps.encode({ kind: "stop" }),
        reason: "scope-violation",
        detail,
      },
      write,
      {
        write: () =>
          Promise.reject(new Error("its branch changed by hand, so dipo writes nothing there")),
      },
    );
    if (tracked !== undefined) tracked.ending = done;
    return done;
  }
}
