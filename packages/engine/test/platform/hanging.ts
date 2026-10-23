// A child process that never exits, for the call deadlines (DIPO-314): its output streams never
// close and its exit never settles, not even after a kill, so a test proves the caller stops
// waiting at its deadline instead of at the child's end. It records the signals it and its group
// were sent.

import type {
  ChildExit,
  ChildProcess,
  ChildStdin,
  Signal,
  Spawn,
  SpawnOptions,
} from "@dipsaus-orchestrator/contract";

/** A stream that never yields and never closes. */
function silent(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: () => {} });
}

export class HangingProcess implements ChildProcess {
  readonly pid: number;
  readonly stdin: ChildStdin | null;
  readonly stdout = silent();
  readonly stderr = silent();
  readonly exited = new Promise<ChildExit>(() => {});
  /** Signals sent to the child itself. */
  readonly signals: Signal[] = [];
  /** Signals sent to the child's process group. */
  readonly groupSignals: Signal[] = [];

  constructor(options: SpawnOptions, pid: number) {
    this.pid = pid;
    this.stdin = options.stdin === "pipe" ? { write: () => {}, end: () => {} } : null;
  }

  kill(signal: Signal = "SIGTERM"): void {
    this.signals.push(signal);
  }

  killGroup(signal: Signal): void {
    this.groupSignals.push(signal);
  }
}

export interface HangingSpawn {
  readonly spawn: Spawn;
  readonly calls: SpawnOptions[];
  readonly children: HangingProcess[];
}

/**
 * A `Spawn` whose children never exit. With `answer`, a call it returns a child for is answered
 * by that child instead (a call that finishes), so one fake can hang only some calls.
 */
export function hangingSpawn(
  answer?: (options: SpawnOptions) => ChildProcess | null,
): HangingSpawn {
  const calls: SpawnOptions[] = [];
  const children: HangingProcess[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const answered = answer?.(options) ?? null;
    if (answered !== null) return answered;
    const child = new HangingProcess(options, 4000 + children.length);
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

/** Lets pending promise callbacks run, so a call reaches its spawn and arms its deadline. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
