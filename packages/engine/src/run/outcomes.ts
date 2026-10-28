// Worker outcomes (DIPO-51; 0008 sections 2, 7 and 8, 0014 section 6). Run control hands this
// every turn problem, rejected init, plan limit and classifier switch of a tracked run, and the
// worker's exit once the turns before it are handled. Every op is stored as a `run_intents` row
// before it is sent; DIPO-51's intents carry a tag at the start of their detail:
//
// - `steer` `report-feedback <why>`: a turn without a valid report gets one feedback turn "report
//   in the schema" (`prompts/feedback/report.md`); the next turn answers it. A second turn without
//   one parks `ambiguous-spec` ("no valid report: <why>", end kind `no-report`). A worker that
//   exits before it answered is resumed with the feedback as its first message.
// - `reassign` `new-session:context-full`: a turn ended `prompt_too_long`; stdin is closed and
//   SIGTERM follows after 10 s. At the exit the agent ends `prompt-too-long` and one new session
//   with a handoff starts. A second full context parks `budget-exceeded` (end kind `capped`).
// - `reassign` `new-session:error`: a turn ended in an execution error while the process waits
//   (maintainer decision Q4): a crash, handled at the exit as one.
// - A crash with no intent (a signal, exit 143, an execution error, a cut stream): usage is
//   already recovered by ingestion; when no earlier agent of the run crashed and no cap fired, the
//   agent ends `crashed` and the session is resumed once (`--resume` when `canResume` holds, else a
//   handoff). Otherwise the story parks `worker-failed` with the last error.
// - `stop` `init-rejected`: a `system/init` that fails its checks (key source, model) stops the
//   worker at once (stdin closed, SIGTERM now, SIGKILL after 30 s) and parks `worker-failed` with
//   an `engine.notice` `run.initRejected` (end kind `init-rejected`).
// - `stop` `start-failed`: a start failure (startup failure, authentication, billing, account on
//   hold) holds the adapter (DIPO-43's hold) and raises `run.startFailed`. When the worktree holds
//   no work the claim is released as DIPO-74 does (worktree removed, branch kept, story Ready);
//   when it holds commits past the claim or a dirty tree, the story parks `worker-failed` and
//   everything is kept (0008 amendment of 2026-10-14).
//   A start the adapter refuses at its first line (`startRefused`, DIPO-108: a plugin the office
//   does not allow) stores the same intent but stops the worker at once, as a rejected init does
//   (stdin closed, SIGTERM now, SIGKILL after 30 s), and never parks for it.
// - A rejected plan limit (a `rate_limit_event` `rejected`, `credits_required`, a 429 turn, or an
//   exit the adapter reads as one) pauses the office's starts (0020, `starts-paused.ts`) and parks
//   the story `worker-failed` with the detail "plan limit until <time>" (end kind `plan-limit`),
//   marked to resume by itself when the pause lifts. An `allowed_warning` changes nothing.
// - A classifier switch is recorded in the session's parser state and announced once per run and
//   model with `engine.notice` `run.modelSwitched`; it never parks.
//
// Each counter fires once per run and they are independent (maintainer decision Q5); they are
// read from facts (`run_intents`, `agents.end_reason`), so a restart keeps them. Every run that
// ends goes through `endRun` (a park, or the claim release of a start failure).
//
// DIPO-128 split the class by responsibility: `outcome-turns.ts` (after a turn), `outcome-exits.ts`
// (at the exit), `outcome-sessions.ts` (next session, start failure), `outcome-restart.ts` (after
// a restart), `outcome-support.ts` (shared facts) and `deciding.ts` (the one deciding guard).
// `outcome-types.ts` holds the vocabulary; this file keeps the public class and re-exports all of
// it. Resuming a parked run is not here: it is `resumption.ts` (DIPO-138), which builds on
// the `parts` this exposes.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { TurnProblem } from "../workers/types";

import { ExitOutcomes } from "./outcome-exits";
import { Redispatch } from "./outcome-restart";
import { SessionStarts } from "./outcome-sessions";
import { OutcomeSupport } from "./outcome-support";
import { TurnOutcomes } from "./outcome-turns";
import type {
  ExitContext,
  HostLostContext,
  PlanLimitHit,
  RunOutcomesDeps,
  RunOutcomesPort,
  RunView,
} from "./outcome-types";

export * from "./outcome-types";

/** The units a resumption shares with worker outcomes: their facts, guard and session starts. */
export interface OutcomeParts {
  readonly support: OutcomeSupport;
  readonly sessions: SessionStarts;
}

export class RunOutcomes implements RunOutcomesPort {
  readonly #support: OutcomeSupport;
  readonly #turns: TurnOutcomes;
  readonly #exits: ExitOutcomes;
  readonly #restart: Redispatch;
  readonly parts: OutcomeParts;

  constructor(deps: RunOutcomesDeps) {
    this.#support = new OutcomeSupport(deps);
    const sessions = new SessionStarts(this.#support);
    this.#turns = new TurnOutcomes(this.#support);
    this.#exits = new ExitOutcomes(this.#support, sessions);
    this.parts = { support: this.#support, sessions };
    this.#restart = new Redispatch(this.#support, this.#exits, sessions);
  }

  onTurnProblem(view: RunView, problem: TurnProblem): Promise<void> {
    return this.#turns.onTurnProblem(view, problem);
  }

  answered(view: RunView): void {
    this.#turns.answered(view);
  }

  onPlanLimit(view: RunView, limit: PlanLimitHit): void {
    this.#turns.onPlanLimit(view, limit);
  }

  onModelSwitched(view: RunView, model: string): void {
    this.#turns.onModelSwitched(view, model);
  }

  onExit(exit: ExitContext): Promise<void> {
    return this.#exits.onExit(exit);
  }

  /** A host found dead after a restart, with no exit file or exit line (DIPO-57). */
  onHostLost(lost: HostLostContext): Promise<void> {
    return this.#exits.onHostLost(lost);
  }

  /** True while an exit or a lost host of the run is being decided here (DIPO-57). */
  busy(runId: string): boolean {
    return this.#support.guard.busy(runId);
  }

  /** The load step that decides the exits a restart left undecided. */
  get feature(): FeatureModule {
    return this.#restart.feature;
  }

  /** Decides the exits a restart left undecided; the number of runs it handled. */
  redispatch(officeId: OfficeId): Promise<number> {
    return this.#restart.redispatch(officeId);
  }
}
