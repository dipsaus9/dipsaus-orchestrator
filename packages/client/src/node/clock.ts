// The real clock of `client/node`: the only client code that reads wall-clock time or arms real
// timers (0017 section 4). The protocol core receives it by injection.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

type NativeTimer = ReturnType<typeof globalThis.setTimeout>;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs) as unknown as TimerHandle,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as NativeTimer),
};
