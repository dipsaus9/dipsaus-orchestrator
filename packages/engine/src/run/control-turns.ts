// The work after every turn of a run (DIPO-49, split out of `control.ts` by DIPO-128): verify and
// commit, one turn at a time, then the turn's problem for worker outcomes (DIPO-51).

import { background } from "../platform/background";
import { withWorkViews } from "../views/work";
import type { TurnProblem, WorkerReport } from "../workers/types";

import type { RunEndings } from "./control-endings";
import { disarm, type RunControlDeps, type Tracked, viewOf } from "./control-types";
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

  /** Queues the after-turn work of one turn; turns of a run are handled one at a time. */
  queue(tracked: Tracked, report: WorkerReport | null, problem?: TurnProblem): void {
    tracked.turns = background(
      () => tracked.turns.then(() => this.#runTurn(tracked, report, problem)),
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
    problem?: TurnProblem,
  ): Promise<void> {
    if (tracked.ending !== null) return;
    const finisher = this.#deps.finisher;
    const decided =
      finisher === undefined ? "continue" : await this.#finishTurn(tracked, finisher, report);
    // A turn the finisher let continue: its problem decides next (DIPO-51).
    const outcomes = this.#deps.outcomes?.();
    if (decided === "continue" && problem !== undefined && outcomes !== undefined) {
      if (tracked.ending === null) await outcomes.onTurnProblem(viewOf(tracked), problem);
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
              cause: decision.cause,
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
          await this.#endings.sendFeedback(office, run, decision.text, write);
          return "decided";
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
