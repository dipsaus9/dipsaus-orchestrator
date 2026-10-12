// A clock that moves only when a test advances it (0017 section 4).

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

/** 2026-01-01T00:00:00.000Z: the default start, fixed so tests never depend on the real date. */
export const MANUAL_CLOCK_START = 1_767_225_600_000;

type Timer = { id: number; due: number; callback: () => void };

export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, Timer>();

  constructor(startMs: number = MANUAL_CLOCK_START) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    const id = this.#nextId++;
    this.#timers.set(id, { id, due: this.#now + delay, callback });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number);
  }

  /** Number of timers armed and not yet fired or cleared. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way in due order
   * (ties in the order they were set). `now()` equals each timer's due time while it runs, so
   * a timer never sees time before its due time. Timers set by a callback fire in the same call
   * when they fall due within the window.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ManualClock.advance needs a finite, non-negative ms, got ${ms}`);
    }
    this.advanceTo(this.#now + ms);
  }

  /** Moves time forward to `targetMs`, firing due timers as `advance` does. */
  advanceTo(targetMs: number): void {
    if (targetMs < this.#now) {
      throw new RangeError(`ManualClock cannot move back from ${this.#now} to ${targetMs}`);
    }
    for (let timer = this.#nextDue(targetMs); timer; timer = this.#nextDue(targetMs)) {
      this.#timers.delete(timer.id);
      this.#now = timer.due;
      timer.callback();
    }
    this.#now = targetMs;
  }

  #nextDue(limit: number): Timer | undefined {
    let first: Timer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.due > limit) continue;
      if (!first || timer.due < first.due || (timer.due === first.due && timer.id < first.id)) {
        first = timer;
      }
    }
    return first;
  }
}
