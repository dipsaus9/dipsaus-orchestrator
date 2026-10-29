// Deadlines of the external calls the engine waits on (DIPO-314): the Backlog CLI
// (`backlog/runner.ts`), `gh` (`platform/host.ts`) and every git step (`git/runner.ts`,
// `git/repo-files.ts`, `office/repository.ts`). Each call starts its child in its own process
// group (`detached`). Past its deadline on the engine clock the group gets SIGTERM, so git can
// remove the lock files it holds; a child that has not exited `KILL_GRACE_MS` later gets SIGKILL
// with its group. The call then fails with a coded `timedOut` error that names the command and the
// deadline, without waiting for the child's output: a killed child may leave a descendant holding
// its pipes. So no such call holds an office's git queue item, or any other serial work that
// awaits it, for longer than its deadline and the grace.
//
// While the daemon runs (`trackEngineCalls`), every such child is tracked until it exits
// (`trackEngineCall`), and the daemon's stop ends the ones still running the same way, on the
// system clock (`stopEngineCalls`), so none outlives the daemon. Outside a daemon (tests, the CLI)
// nothing is tracked.

import type { ChildProcess, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { systemClock } from "./clock";

/** The default deadline of one Backlog CLI or `gh` call: 60 seconds. */
export const CALL_DEADLINE_MS = 60_000;

/** How long a child gets after SIGTERM before SIGKILL: 2 seconds. */
export const KILL_GRACE_MS = 2_000;

/** The error code of a call killed at its deadline. */
export const TIMED_OUT = "timedOut";

/** What ending a child needs: its signals and its exit. */
export type Killable = Pick<ChildProcess, "kill" | "killGroup" | "exited">;

/** The deadline in whole seconds, for messages. */
export function deadlineSeconds(deadlineMs: number): number {
  return Math.max(1, Math.round(deadlineMs / 1000));
}

/** The fixed text of a call killed at its deadline: the command and the deadline. */
export function timedOutText(command: readonly string[], deadlineMs: number): string {
  return `\`${command.join(" ")}\` did not finish within its deadline of ${deadlineSeconds(deadlineMs)} s; dipo stopped it and its process group`;
}

/** Sends `signal` to the child's group, when it leads one, and to the child itself. */
function signalChild(
  child: Pick<ChildProcess, "kill" | "killGroup">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    child.killGroup?.(signal);
  } catch {
    // The group is gone already.
  }
  child.kill(signal);
}

/**
 * Ends `child` and its process group: SIGTERM now, then SIGKILL unless the child exited within
 * `graceMs` on `clock`. Resolves once the child exited or was sent SIGKILL.
 */
export function terminateChild(
  child: Killable,
  clock: Clock,
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  let exited = false;
  return new Promise<void>((resolve) => {
    const timer = clock.setTimeout(() => {
      if (!exited) signalChild(child, "SIGKILL");
      resolve();
    }, graceMs);
    const done = () => {
      exited = true;
      clock.clearTimeout(timer);
      resolve();
    };
    child.exited.then(done, done);
    signalChild(child, "SIGTERM");
  });
}

/**
 * Kills `child` and every process of its group with SIGKILL at once: the group through
 * `killGroup` when the child was spawned in its own group, and the child itself in any case.
 */
export function killChildGroup(child: Pick<ChildProcess, "kill" | "killGroup">): void {
  signalChild(child, "SIGKILL");
}

export interface DeadlineOptions {
  readonly clock: Clock;
  readonly deadlineMs: number;
  /** The error the call fails with at its deadline. */
  readonly timedOut: () => Error;
  /** How long the child gets after SIGTERM; `KILL_GRACE_MS` by default. */
  readonly graceMs?: number;
}

/**
 * Waits for `work` (the child's output and exit) until the deadline on `clock`. Past it the
 * child's process group is ended (`terminateChild`) and the call rejects with `timedOut()`, without
 * waiting for the output. A deadline of 0 or less, or one that is not finite, waits without end.
 */
export async function withDeadline<T>(
  child: Killable,
  work: Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const { clock, deadlineMs } = options;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return work;
  let timer: TimerHandle | undefined;
  let fired = false;
  const expired = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      timer = undefined;
      fired = true;
      void terminateChild(child, clock, options.graceMs).then(() => reject(options.timedOut()));
    }, deadlineMs);
  });
  // The work may still settle after the deadline (a killed child's exit); nobody waits for it.
  work.catch(() => undefined);
  try {
    // A child that ends on its SIGTERM, with whatever output, still timed out.
    const settled = work.then(
      (result) => (fired ? expired : result),
      (error: unknown) => (fired ? expired : Promise.reject(error)),
    );
    return await Promise.race([settled, expired]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

// ---- the calls still running -------------------------------------------------------------------

/** The engine's external calls still running, so the daemon's stop can end them. */
export class EngineCalls {
  readonly #running = new Set<Killable>();
  #on = false;

  /** From now on `track` keeps the calls it is given, until `stop`. */
  start(): void {
    this.#on = true;
  }

  /** Tracks `child` until it exits, while started. */
  track(child: Killable): void {
    if (!this.#on) return;
    this.#running.add(child);
    const done = () => this.#running.delete(child);
    child.exited.then(done, done);
  }

  /** How many tracked calls still run. */
  get size(): number {
    return this.#running.size;
  }

  /**
   * Stops tracking and ends every tracked call and its group (`terminateChild`); resolves once
   * all are ended, with how many there were.
   */
  async stop(clock: Clock, graceMs: number = KILL_GRACE_MS): Promise<number> {
    this.#on = false;
    const running = [...this.#running];
    this.#running.clear();
    await Promise.all(running.map((child) => terminateChild(child, clock, graceMs)));
    return running.length;
  }
}

/** The daemon's one set of running engine calls. */
export const ENGINE_CALLS = new EngineCalls();

/** Tracks a child of an engine call in `ENGINE_CALLS` until it exits. */
export function trackEngineCall(child: Killable): void {
  ENGINE_CALLS.track(child);
}

/** The daemon's start: from now on its engine calls are tracked. */
export function trackEngineCalls(): void {
  ENGINE_CALLS.start();
}

/**
 * The daemon's stop: ends every engine call still running, SIGTERM then SIGKILL after the grace
 * on the system clock; returns how many there were.
 */
export function stopEngineCalls(clock: Clock = systemClock, graceMs?: number): Promise<number> {
  return ENGINE_CALLS.stop(clock, graceMs);
}
