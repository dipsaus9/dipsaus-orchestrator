// Event batching for the TUI (0009 section 9): the store applies every event at once, but the TUI
// takes its state at most 10 times per second. The first change after a quiet spell shows at
// once; changes within the next 100 ms are shown together when it ends.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";
import { useEffect, useState } from "react";

/** At most 10 batches per second. */
export const BATCH_MS = 100;

/** Calls `flush` on the first change, then at most once per `intervalMs` while changes come. */
export class Batcher {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #flush: () => void;
  #timer: TimerHandle | null = null;
  #dirty = false;

  constructor(clock: Clock, intervalMs: number, flush: () => void) {
    this.#clock = clock;
    this.#intervalMs = intervalMs;
    this.#flush = flush;
  }

  changed(): void {
    if (this.#timer !== null) {
      this.#dirty = true;
      return;
    }
    this.#flush();
    this.#arm();
  }

  stop(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#dirty = false;
  }

  #arm(): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#flush();
      this.#arm();
    }, this.#intervalMs);
  }
}

/** The store's state, taken at most once per `intervalMs`. */
export function useBatchedState(
  store: OfficeStore,
  clock: Clock,
  intervalMs: number = BATCH_MS,
): OfficeStoreState {
  const [state, setState] = useState(store.state);
  useEffect(() => {
    const batcher = new Batcher(clock, intervalMs, () => setState(store.state));
    const stop = store.subscribe(() => batcher.changed());
    // A change between the first render and this subscription.
    batcher.changed();
    return () => {
      stop();
      batcher.stop();
    };
  }, [store, clock, intervalMs]);
  return state;
}
