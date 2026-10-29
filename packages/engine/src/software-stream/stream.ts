// The software stream (0005 section 6, 0006 decision 9): office list and daemon events kept in an
// in-memory ring buffer of the last 1000 entries, with a random epoch at every daemon start. A
// cursor of another epoch, below the oldest entry still kept, or past the head cannot be replayed
// and gets `stream.resetRequired { oldest }`, so every client re-reads `engine.hello` after a
// daemon restart. Losing the buffer is harmless: the office list itself is the `offices` table.

import {
  type Clock,
  type Cursor,
  engineError,
  type EngineError,
  type Event,
  type EventDefinition,
  findEvent,
  SOFTWARE_STREAM,
} from "@dipsaus-orchestrator/contract";

import { newEpoch } from "../changelog/log";
import type { RandomFill } from "../platform/ids";

/** How many entries the software stream keeps (0006 decision 9). */
export const SOFTWARE_STREAM_CAPACITY = 1000;

// The stream name lives in the contract; the engine keeps its name for it.
export { SOFTWARE_STREAM };

export type SoftwareReplay =
  | { readonly ok: true; readonly events: readonly Event[]; readonly head: Cursor }
  | { readonly ok: false; readonly error: EngineError };

export type SoftwareListener = (event: Event) => void;

export interface SoftwareStreamOptions {
  readonly clock: Clock;
  readonly capacity?: number;
  /** Randomness for the epoch; tests pass a fixed one. */
  readonly fill?: RandomFill;
}

/** The definition of `type`; throws unless it is a stored (not derived) event the software stream may carry. */
function softwareFactDefinition(type: string): EventDefinition {
  const definition = findEvent(type);
  if (definition === undefined) throw new Error(`Unknown event type ${type}.`);
  if (definition.derived) throw new Error(`${type} is derived and never stored.`);
  if (definition.stream === "office") throw new Error(`${type} belongs to an office stream.`);
  return definition;
}

export class SoftwareStream {
  readonly epoch: string;
  readonly #clock: Clock;
  readonly #capacity: number;
  readonly #entries: Event[] = [];
  /** Seq of the last entry appended; 0 before the first. */
  #headSeq = 0;
  readonly #listeners = new Set<SoftwareListener>();

  constructor(options: SoftwareStreamOptions) {
    this.#clock = options.clock;
    this.#capacity = options.capacity ?? SOFTWARE_STREAM_CAPACITY;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) {
      throw new RangeError(`The software stream needs a positive capacity, got ${this.#capacity}.`);
    }
    this.epoch = newEpoch(options.fill);
  }

  /** The cursor of the last entry appended (seq 0 before the first). */
  head(): Cursor {
    return this.#cursor(this.#headSeq);
  }

  /** The oldest cursor that can still be replayed: just before the oldest entry kept. */
  oldest(): Cursor {
    const first = this.#entries[0];
    return this.#cursor(first === undefined ? this.#headSeq : first.cursor.seq - 1);
  }

  /** Appends one fact, tells every listener, and returns the event. */
  append(type: string, data: unknown): Event {
    const parsed = softwareFactDefinition(type).data.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${type} data does not match its schema: ${parsed.error.message}`);
    }
    this.#headSeq += 1;
    const event: Event = {
      cursor: this.#cursor(this.#headSeq),
      at: new Date(this.#clock.now()).toISOString(),
      type,
      data: parsed.data,
    };
    this.#entries.push(event);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  /** Every entry after `after`, in order, or `stream.resetRequired` with the oldest cursor. */
  since(after: Cursor): SoftwareReplay {
    const oldest = this.oldest();
    const valid =
      after.stream === SOFTWARE_STREAM &&
      after.epoch === this.epoch &&
      after.seq >= oldest.seq &&
      after.seq <= this.#headSeq;
    if (!valid) {
      return {
        ok: false,
        error: engineError(
          "stream.resetRequired",
          "This cursor can no longer be replayed; read engine.hello again and subscribe after its cursor.",
          { oldest },
        ),
      };
    }
    const skip = after.seq - oldest.seq;
    return { ok: true, events: this.#entries.slice(skip), head: this.head() };
  }

  /** Calls `listener` for every later entry; returns a function that removes it. */
  onAppend(listener: SoftwareListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #cursor(seq: number): Cursor {
    return { stream: SOFTWARE_STREAM, epoch: this.epoch, seq };
  }
}
