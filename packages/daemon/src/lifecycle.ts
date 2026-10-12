// The daemon lifecycle (0006 decision 7): `starting -> recovering -> running | safe -> draining`,
// and `safe -> running` when scheduling resumes. `stopped` is the absence of a daemon, so it is no
// state here. SIGTERM always means the graceful drain (0006 decision 7), so every live state may
// enter `draining`, also before recovery has finished.
//
// The machine keeps the current state with its reason and reports every transition as
// `{ from, to, reason }` to its listeners; DIPO-24 emits them as `daemon.state` on the software
// stream. The predicates below are what the command and read executors ask before they run.

import { engineError, type DaemonState, type EngineError } from "@dipsaus-orchestrator/contract";
import { CommandError } from "@dipsaus-orchestrator/engine";

/** One transition, as `daemon.state` carries it. */
export interface StateChange {
  readonly from: DaemonState;
  readonly to: DaemonState;
  readonly reason: string;
}

export type StateListener = (change: StateChange) => void;

/** The transitions of 0006 decision 7; anything else throws. */
export const TRANSITIONS: Readonly<Record<DaemonState, readonly DaemonState[]>> = {
  starting: ["recovering", "draining"],
  recovering: ["running", "safe", "draining"],
  running: ["draining"],
  safe: ["running", "draining"],
  draining: [],
};

export class TransitionError extends Error {
  constructor(
    readonly from: DaemonState,
    readonly to: DaemonState,
  ) {
    super(`The daemon cannot move from ${from} to ${to} (0006 decision 7).`);
    this.name = "TransitionError";
  }
}

/** The reason `safe` carries after a crash loop (0006 decision 7). */
export const CRASH_LOOP_REASON = "crash loop";

export class DaemonLifecycle {
  #state: DaemonState = "starting";
  #reason: string;
  readonly #listeners = new Set<StateListener>();
  #inFlight = 0;
  readonly #idleWaiters: (() => void)[] = [];

  constructor(reason = "daemon started") {
    this.#reason = reason;
  }

  get state(): DaemonState {
    return this.#state;
  }

  get reason(): string {
    return this.#reason;
  }

  /** Registers a listener for every later transition; returns a function that removes it. */
  onTransition(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Moves to `to`; throws `TransitionError` for a move 0006 decision 7 does not allow. */
  transition(to: DaemonState, reason: string): StateChange {
    const from = this.#state;
    if (!TRANSITIONS[from].includes(to)) throw new TransitionError(from, to);
    this.#state = to;
    this.#reason = reason;
    const change: StateChange = { from, to, reason };
    for (const listener of this.#listeners) listener(change);
    return change;
  }

  /**
   * Leaves `safe` for `running`; `daemon.resumeScheduling` (DIPO-24) calls it. Outside `safe` it
   * throws the `daemon.notSafe` command error (0005 section 4).
   */
  resumeScheduling(reason = "scheduling resumed"): StateChange {
    if (this.#state !== "safe") {
      throw new CommandError(
        "daemon.notSafe",
        `Scheduling is not off: the daemon is ${this.#state}, not safe.`,
        { state: this.#state },
      );
    }
    return this.transition("running", reason);
  }

  /**
   * Office access (0006 decision 7): office commands and reads fail with the retryable
   * `engine.recovering` in `starting` and `recovering`; null means they may run.
   */
  officeAccess(): EngineError | null {
    if (this.#state === "starting" || this.#state === "recovering") {
      return engineError(
        "engine.recovering",
        "The daemon is starting and recovering its offices; try again shortly.",
        { state: this.#state },
      );
    }
    return null;
  }

  /**
   * Scheduling (0006 decision 7): a command that would schedule work (`work.run`, resume to In
   * Progress) fails with the retryable `scheduling.off` in `safe`, and in `draining`, where no new
   * work starts. Office access is checked first, so `starting` and `recovering` report
   * `engine.recovering`. Null means the command may schedule work.
   */
  scheduling(): EngineError | null {
    const access = this.officeAccess();
    if (access !== null) return access;
    if (this.#state === "safe") {
      return engineError(
        "scheduling.off",
        `Scheduling is off (${this.#reason}); run \`dipo daemon resume-scheduling\` to turn it on.`,
        { state: this.#state, reason: this.#reason },
      );
    }
    if (this.#state === "draining") {
      return engineError("scheduling.off", "The daemon is stopping; no new work starts.", {
        state: this.#state,
        reason: this.#reason,
      });
    }
    return null;
  }

  /**
   * Starts one piece of work the drain must let finish (a command's writes, a recovery step).
   * Returns the function that ends it, or null in `draining`, where no new work starts.
   */
  beginWork(): (() => void) | null {
    if (this.#state === "draining") return null;
    this.#inFlight++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#inFlight--;
      if (this.#inFlight === 0) {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    };
  }

  /** The number of pieces of work started and not yet ended. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Resolves once no work is in flight. */
  idle(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }
}
