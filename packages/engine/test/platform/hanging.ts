// A child process that never exits, for the call deadlines (DIPO-314): its output streams never
// close and its exit never settles, not even after a kill (it ignores every signal, SIGKILL
// included, as a child stuck in the kernel does), so a test proves the caller stops waiting at its
// deadline instead of at the child's end. It records the signals it and its group were sent. With
// `exitOn`, it exits on that signal, as a git that removes its locks on SIGTERM does.

import type {
  ChildExit,
  ChildProcess,
  ChildStdin,
  Signal,
  Spawn,
  SpawnOptions,
} from "@dipsaus-orchestrator/contract";

/** A stream that yields nothing and closes only when `close` is called. */
function silent(): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return { stream, close: () => controller?.close() };
}

export class HangingProcess implements ChildProcess {
  readonly pid: number;
  readonly stdin: ChildStdin | null;
  readonly #out = silent();
  readonly #err = silent();
  readonly stdout = this.#out.stream;
  readonly stderr = this.#err.stream;
  readonly exited: Promise<ChildExit>;
  readonly #exit: (exit: ChildExit) => void;
  readonly #exitOn: Signal | null;
  /** Signals sent to the child itself. */
  readonly signals: Signal[] = [];
  /** Signals sent to the child's process group. */
  readonly groupSignals: Signal[] = [];

  constructor(options: SpawnOptions, pid: number, exitOn: Signal | null = null) {
    this.pid = pid;
    this.stdin = options.stdin === "pipe" ? { write: () => {}, end: () => {} } : null;
    const exit = Promise.withResolvers<ChildExit>();
    this.exited = exit.promise;
    this.#exit = exit.resolve;
    this.#exitOn = exitOn;
  }

  kill(signal: Signal = "SIGTERM"): void {
    this.signals.push(signal);
    if (signal !== this.#exitOn) return;
    // It ends: its output closes, then its exit settles.
    this.#out.close();
    this.#err.close();
    this.#exit({ code: null, signal });
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
  exitOn: Signal | null = null,
): HangingSpawn {
  const calls: SpawnOptions[] = [];
  const children: HangingProcess[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const answered = answer?.(options) ?? null;
    if (answered !== null) return answered;
    const child = new HangingProcess(options, 4000 + children.length, exitOn);
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

/** Lets pending promise callbacks run, so a call reaches its spawn and arms its deadline. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
