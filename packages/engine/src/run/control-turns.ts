// The work after every turn of a run (DIPO-49, split out of `control.ts` by DIPO-128): verify and
// commit, one turn at a time, then the turn's problem for worker outcomes (DIPO-51).

import { background } from "../platform/background";
import { withWorkViews } from "../views/work";
import type { ReviewReport, TurnProblem, WorkerReport } from "../workers/types";

import type { FiredCap } from "./caps";
import { capEnding, type RunEndings } from "./control-endings";
import { disarm, messageOf, type RunControlDeps, type Tracked, viewOf } from "./control-types";
import { notSentNotice, sendFeedback } from "./feedback";
import type { ParkOutcome } from "./park";
import { findRun } from "./records";
import type { RunFinisher } from "./verify-commit";

export class AfterTurns {
  readonly #deps: RunControlDeps;
  readonly #endings: RunEndings;
  readonly #inflight: Set<Promise<unknown>>;

  constructor(deps: RunControlDeps, endings: RunEndings, inflight: Set<Promise<unknown>>) {
    this.#deps = deps;
    this.#endings = endings;
    this.#inflight = inflight;
  }

  /**
   * Queues the after-turn work of one turn; turns of a run are handled one at a time. `review` is
   * a reviewer session's valid report (DIPO-219).
   */
  queue(
    tracked: Tracked,
    report: WorkerReport | null,
    problem?: TurnProblem,
    capped: FiredCap | null = null,
    review?: ReviewReport,
  ): void {
    tracked.turns = background(
      () => tracked.turns.then(() => this.#runTurn(tracked, report, problem, capped, review)),
      {
        failed: "verify and commit after a turn failed",
        fields: { run: tracked.runId },
        log: this.#deps.warn,
        inflight: this.#inflight,
      },
    );
  }

  async #runTurn(
    tracked: Tracked,
    report: WorkerReport | null,
    problem: TurnProblem | undefined,
    capped: FiredCap | null,
    review: ReviewReport | undefined,
  ): Promise<void> {
    if (tracked.ending !== null) return;
    const finisher = this.#deps.finisher;
    let decided: "continue" | "decided" = "continue";
    if (finisher !== undefined) {
      try {
        decided = await this.#finishTurn(tracked, finisher, report, capped);
      } catch (thrown: unknown) {
        // A capped done turn must still end at its cap when the finisher throws (DIPO-235): the
        // run has no other ending yet, so the cap ending goes in its place.
        if (capped === null || tracked.ending !== null) throw thrown;
        this.#deps.warn?.("verify and commit after a capped turn failed; ending at the cap", {
          run: tracked.runId,
          cap: capped.cap,
          detail: capped.detail,
          reason: messageOf(thrown),
        });
        this.#endings.begin(tracked, capEnding(this.#deps.encode, capped.cap, capped.detail));
        return;
      }
    }
    // A done turn that crossed a cap and that the finisher let continue (no worktree, a session
    // run) ends at the cap, as before DIPO-205; the cap run step is only for the done path.
    if (decided === "continue" && capped !== null) {
      if (tracked.ending === null) {
        this.#endings.begin(tracked, capEnding(this.#deps.encode, capped.cap, capped.detail));
      }
      return;
    }
    // A turn the finisher let continue: its problem decides next (DIPO-51).
    const outcomes = this.#deps.outcomes?.();
    // A reviewer's report the backstop let through is judged by the review rounds (DIPO-219).
    if (decided === "continue" && review !== undefined && outcomes?.onReview !== undefined) {
      if (tracked.ending === null) await outcomes.onReview(viewOf(tracked), review);
      return;
    }
    if (decided === "continue" && problem !== undefined && outcomes !== undefined) {
      if (tracked.ending === null) await outcomes.onTurnProblem(viewOf(tracked), problem);
    }
  }

  /** Verify and commit after one turn (DIPO-49); `continue` when the turn decided nothing. */
  async #finishTurn(
    tracked: Tracked,
    finisher: RunFinisher,
    report: WorkerReport | null,
    capped: FiredCap | null,
  ): Promise<"continue" | "decided"> {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return "decided";
    const run = findRun(office, tracked.runId);
    if (run === null || run.endedAt !== null) return "decided";
    const { promise: mine, resolve: settle } = Promise.withResolvers<ParkOutcome | null>();
    const claim = (): boolean => {
      if (tracked.ending !== null) return tracked.ending === mine;
      disarm(this.#deps.clock, tracked);
      tracked.ending = mine;
      return true;
    };
    const write = this.#endings.writer(office, tracked.office);
    try {
      const decision = await finisher.afterTurn({
        office,
        run,
        work: tracked.work,
        report,
        capped,
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
          const outcome = await this.#endings.end(
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
              ...(capped === null ? {} : { capStep: `${capped.cap}: ${capped.detail}` }),
            },
            write,
          );
          settle(outcome);
          return "decided";
        }
        case "feedback": {
          if (tracked.ending !== null) return "decided";
          const error = await sendFeedback(
            office,
            run.runId,
            { source: decision.source, text: decision.text },
            { sender: this.#deps },
          ).done;
          if (error !== null) write(() => [notSentNotice(run, decision.source, error)]);
          return "decided";
        }
        case "ended":
          // The In Review commit is read again at the branch tip (DIPO-56).
          await this.#endings.refresh(office, run, "In Review");
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
}
