// Work in slices on the daemon's one JS thread (0007 sections 1 and 7). Every SQLite call blocks
// every office, so retention and maintenance run in short calls with a budget of 50 ms each and
// let the event loop run between them. A retention batch deletes at most 5,000 rows; after a call
// over budget the next batch is half the size, after a quick one it grows back.

import type { Clock } from "@dipsaus-orchestrator/contract";

import { yieldToEventLoop } from "../platform/clock";

/** At most this many rows per retention transaction (0007 section 7). */
export const MAX_BATCH_ROWS = 5_000;

/** The time budget of one SQLite call of a background job (0007 section 1). */
export const SLICE_BUDGET_MS = 50;

const MIN_BATCH = 50;

export interface SliceOptions {
  readonly clock: Clock;
  /** The largest batch; defaults to `MAX_BATCH_ROWS`. */
  readonly maxBatch?: number;
  readonly budgetMs?: number;
  /** Runs between slices; defaults to one turn of the event loop. Tests pass a no-op. */
  readonly pause?: () => Promise<void>;
}

/** One slice: what the call returned, the batch size it was given and how long it took. */
export interface Slice<T> {
  readonly result: T;
  readonly limit: number;
  readonly ms: number;
}

export class Slicer {
  readonly #clock: Clock;
  readonly #max: number;
  readonly #budget: number;
  readonly #pause: () => Promise<void>;
  #size: number;
  /** The slowest call so far, for the log. */
  slowestMs = 0;

  constructor(options: SliceOptions) {
    this.#clock = options.clock;
    this.#max = Math.max(1, Math.min(options.maxBatch ?? MAX_BATCH_ROWS, MAX_BATCH_ROWS));
    this.#budget = options.budgetMs ?? SLICE_BUDGET_MS;
    this.#pause = options.pause ?? yieldToEventLoop;
    this.#size = this.#max;
  }

  /** The batch size the next slice gets. */
  get size(): number {
    return this.#size;
  }

  /** Runs `fn` with the current batch size, adapts the size to the time it took, then yields. */
  async slice<T>(fn: (limit: number) => T): Promise<Slice<T>> {
    const limit = this.#size;
    const started = this.#clock.now();
    const result = fn(limit);
    const ms = Math.max(0, this.#clock.now() - started);
    this.slowestMs = Math.max(this.slowestMs, ms);
    if (ms > this.#budget) {
      this.#size = Math.max(Math.min(MIN_BATCH, this.#max), Math.floor(limit / 2));
    } else if (ms < this.#budget / 2) {
      this.#size = Math.min(this.#max, limit * 2);
    }
    await this.#pause();
    return { result, limit, ms };
  }
}
