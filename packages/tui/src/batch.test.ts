// Event batching (DIPO-54, 0009 section 9): at most one flush per 100 ms, the first change at once.

import { describe, expect, it } from "bun:test";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { Batcher, BATCH_MS } from "./batch";

/** A clock whose timers fire only when the test moves time. */
class StepClock implements Clock {
  #now = 0;
  #timers = new Map<number, { due: number; callback: () => void }>();
  #next = 1;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { due: this.#now + delayMs, callback });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number);
  }

  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= until)
        .toSorted((a, b) => a[1].due - b[1].due)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].due;
      due[1].callback();
    }
    this.#now = until;
  }

  get pending(): number {
    return this.#timers.size;
  }
}

describe("Batcher", () => {
  it("flushes the first change at once and the rest at most every 100 ms", () => {
    const clock = new StepClock();
    const flushes: number[] = [];
    const batcher = new Batcher(clock, BATCH_MS, () => flushes.push(clock.now()));
    // 1,000 events per second for two seconds.
    for (let ms = 0; ms < 2_000; ms++) {
      batcher.changed();
      clock.advance(1);
    }
    clock.advance(BATCH_MS);
    expect(flushes[0]).toBe(0);
    expect(flushes.length).toBeLessThanOrEqual(21);
    for (let i = 1; i < flushes.length; i++) {
      expect(flushes[i]! - flushes[i - 1]!).toBeGreaterThanOrEqual(BATCH_MS);
    }
    // Quiet again: no timer is left, and the next change flushes at once.
    expect(clock.pending).toBe(0);
    const before = flushes.length;
    batcher.changed();
    expect(flushes).toHaveLength(before + 1);
  });

  it("flushes nothing after the last change was shown, and nothing after stop", () => {
    const clock = new StepClock();
    let flushes = 0;
    const batcher = new Batcher(clock, BATCH_MS, () => (flushes += 1));
    batcher.changed();
    clock.advance(BATCH_MS * 3);
    expect(flushes).toBe(1);
    batcher.changed();
    batcher.changed();
    batcher.stop();
    clock.advance(BATCH_MS * 3);
    expect(flushes).toBe(2);
    expect(clock.pending).toBe(0);
  });
});
