// Steering inside the worker host: each host op becomes a stdin write, a stdin close or a signal
// to the worker (0008 sections 1 and 6). A signal with `afterMs` is armed on the injected clock
// and cancelled when the worker exits, so a delayed SIGTERM or SIGKILL can never reach a process
// that later reuses the worker's PID (DIPO-44 AC #9).

import type { ChildProcess, Clock, Signal, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { HostOp } from "../workers/types";
import type { HostError, OpFrame } from "./protocol";

export type SteerResult = { readonly ok: true } | { readonly ok: false; readonly error: HostError };

const OK: SteerResult = { ok: true };

function failed(code: HostError["code"], message: string): SteerResult {
  return { ok: false, error: { code, message } };
}

/**
 * The host op a steering frame carries; null for `status` and `watch`, which are not steering: the
 * host handles them itself.
 */
export function hostOpOf(frame: OpFrame): HostOp | null {
  switch (frame.op) {
    case "write":
      return { write: frame.data };
    case "signal":
      return frame.afterMs === undefined
        ? { signal: frame.signal }
        : { signal: frame.signal, afterMs: frame.afterMs };
    case "closeStdin":
      return { closeStdin: true };
    case "status":
    case "watch":
      return null;
  }
}

export class Steering {
  readonly #child: ChildProcess;
  readonly #clock: Clock;
  readonly #timers = new Set<TimerHandle>();
  #stdinOpen: boolean;
  #exited = false;
  #lastSignal: Signal | null = null;
  readonly #onSignal: ((signal: Signal) => void) | undefined;

  /** `onSignal` hears each signal sent to the worker, right after it is sent (DIPO-271). */
  constructor(child: ChildProcess, clock: Clock, onSignal?: (signal: Signal) => void) {
    this.#child = child;
    this.#clock = clock;
    this.#stdinOpen = child.stdin !== null;
    this.#onSignal = onSignal;
  }

  get stdinOpen(): boolean {
    return this.#stdinOpen && !this.#exited;
  }

  /**
   * The signal last sent to the worker, null when none was (DIPO-88). A delayed signal counts
   * once its timer fired, never while it is only armed.
   */
  get lastSignal(): Signal | null {
    return this.#lastSignal;
  }

  /** Delayed signals still armed. */
  get pendingSignals(): number {
    return this.#timers.size;
  }

  apply(op: HostOp): SteerResult {
    if (this.#exited) return failed("worker.exited", "The worker has exited.");
    if ("write" in op) return this.#write(op.write);
    if ("closeStdin" in op) return this.#closeStdin();
    if (op.afterMs === undefined || op.afterMs <= 0) {
      this.#kill(op.signal);
      return OK;
    }
    const signal = op.signal;
    const timer = this.#clock.setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#exited) this.#kill(signal);
    }, op.afterMs);
    this.#timers.add(timer);
    return OK;
  }

  /** The worker has exited: cancel every delayed signal and refuse further ops. */
  workerExited(): number {
    this.#exited = true;
    const cancelled = this.#timers.size;
    for (const timer of this.#timers) this.#clock.clearTimeout(timer);
    this.#timers.clear();
    return cancelled;
  }

  #kill(signal: Signal): void {
    this.#lastSignal = signal;
    this.#child.kill(signal);
    this.#onSignal?.(signal);
  }

  #write(data: string): SteerResult {
    const stdin = this.#child.stdin;
    if (stdin === null || !this.#stdinOpen) return failed("stdin.closed", "Stdin is closed.");
    try {
      stdin.write(data);
      return OK;
    } catch (error) {
      return failed("stdin.failed", error instanceof Error ? error.message : String(error));
    }
  }

  #closeStdin(): SteerResult {
    const stdin = this.#child.stdin;
    if (stdin === null || !this.#stdinOpen) return OK;
    this.#stdinOpen = false;
    try {
      stdin.end();
    } catch {
      // The worker closed its end already.
    }
    return OK;
  }
}
