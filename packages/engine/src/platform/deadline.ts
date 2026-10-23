// Deadlines of the external calls the engine waits on (DIPO-314): the Backlog CLI
// (`backlog/runner.ts`), `gh` (`platform/host.ts`) and every git step (`git/runner.ts`). Each call
// starts its child in its own process group (`detached`), and past its deadline on the engine
// clock the whole group is killed and the call fails at once with a coded `timedOut` error that
// names the command and the deadline. The call does not wait for the child's output after that: a
// killed child may leave a descendant holding its pipes. So no such call can hold an office's git
// queue item, or any other serial work that awaits it, for longer than its deadline.

import type { ChildProcess, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

/** The default deadline of one Backlog CLI, `gh` or git call: 60 seconds. */
export const CALL_DEADLINE_MS = 60_000;

/** The error code of a call killed at its deadline. */
export const TIMED_OUT = "timedOut";

/** The deadline in whole seconds, for messages. */
export function deadlineSeconds(deadlineMs: number): number {
  return Math.max(1, Math.round(deadlineMs / 1000));
}

/** The fixed text of a call killed at its deadline: the command and the deadline. */
export function timedOutText(command: readonly string[], deadlineMs: number): string {
  return `\`${command.join(" ")}\` did not finish within its deadline of ${deadlineSeconds(deadlineMs)} s; dipo killed it and its process group`;
}

/**
 * Kills `child` and every process of its group with SIGKILL: the group through `killGroup` when
 * the child was spawned in its own group, and the child itself in any case.
 */
export function killChildGroup(child: ChildProcess): void {
  try {
    child.killGroup?.("SIGKILL");
  } catch {
    // The group is gone already.
  }
  child.kill("SIGKILL");
}

export interface DeadlineOptions {
  readonly clock: Clock;
  readonly deadlineMs: number;
  /** The error the call fails with at its deadline. */
  readonly timedOut: () => Error;
}

/**
 * Waits for `work` (the child's output and exit) until the deadline on `clock`. Past it the
 * child's process group is killed and the call rejects with `timedOut()` at once, without waiting
 * for the output. A deadline of 0 or less, or one that is not finite, waits without end.
 */
export async function withDeadline<T>(
  child: ChildProcess,
  work: Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const { clock, deadlineMs } = options;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return work;
  let timer: TimerHandle | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      killChildGroup(child);
      reject(options.timedOut());
    }, deadlineMs);
  });
  // The work may still settle after the deadline (a killed child's exit); nobody waits for it.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}
