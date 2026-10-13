// The system clock: the only engine code that reads wall-clock time or arms real timers
// (0017 section 4). Everything else receives a `Clock` by injection.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

type NativeTimer = ReturnType<typeof globalThis.setTimeout>;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs) as unknown as TimerHandle,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as NativeTimer),
};

/**
 * Resolves after pending I/O callbacks had their turn. Jobs that work in slices (retention,
 * maintenance, 0007 section 1) await it between slices, so other offices' requests run in between.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
