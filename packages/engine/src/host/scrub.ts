// The stdout scrub of the worker host (DIPO-105, 0007 section 8): the plan's `lineScrub` names the
// fields to remove from the typed objects of a stdout line, so a thinking text or signature never
// reaches `events.ndjson`. The host applies the rule as data and does not know what the types
// mean. A line the rule does not touch comes back byte for byte, so only changed lines are
// re-encoded.

import type { LineScrub } from "../workers/types";

/**
 * The most a capped line is held for the scrub, in UTF-16 code units (about its bytes for stream
 * JSON; 16 Mi, four splitter pieces). A longer line is dropped up to its newline (DIPO-175), so a
 * worker that never ends one cannot grow the host's memory, and no part of it reaches the event
 * file. The host logs each drop, so a lost line is not silent.
 */
export const MAX_SCRUB_LINE = 16 * 1024 * 1024;

/**
 * Scrubs the stdout lines the splitter cut into pieces (DIPO-175): the pieces of one line are held
 * until its newline and scrubbed as one line, so a field that sits in another piece than its text
 * is removed too.
 */
export class LineScrubber {
  readonly #scrub: LineScrub;
  readonly #maxLine: number;
  readonly #onDrop: (held: number) => void;
  #held = "";
  #dropping = false;

  /** `onDrop` hears of each dropped line, with the code units held when it passed the cap. */
  constructor(
    scrub: LineScrub,
    maxLine: number = MAX_SCRUB_LINE,
    onDrop: (held: number) => void = () => {},
  ) {
    this.#scrub = scrub;
    this.#maxLine = maxLine;
    this.#onDrop = onDrop;
  }

  /** Takes the next piece; returns the scrubbed line when the piece completes one, else null. */
  push(piece: string): string | null {
    if (this.#dropping) {
      this.#dropping = !piece.endsWith("\n");
      return null;
    }
    this.#held += piece;
    if (this.#held.length > this.#maxLine) {
      this.#onDrop(this.#held.length);
      this.#held = "";
      this.#dropping = !piece.endsWith("\n");
      return null;
    }
    return piece.endsWith("\n") ? this.#take() : null;
  }

  /** The held partial line at the end of the stream, scrubbed, or null. */
  flush(): string | null {
    if (this.#dropping) {
      this.#dropping = false;
      return null;
    }
    return this.#held === "" ? null : this.#take();
  }

  #take(): string {
    const line = this.#held;
    this.#held = "";
    return scrubLine(line, this.#scrub);
  }
}

/**
 * `line` (with its newline, when it has one) with the scrub's fields removed. A line that is not
 * JSON is returned as it is.
 */
export function scrubLine(line: string, scrub: LineScrub): string {
  const newline = line.endsWith("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(newline ? line.slice(0, -1) : line);
  } catch {
    return line;
  }
  if (!removeFields(parsed, scrub)) return line;
  return `${JSON.stringify(parsed)}${newline ? "\n" : ""}`;
}

/** Removes the scrub's fields from every typed object under `value`; true when one was removed. */
function removeFields(value: unknown, scrub: LineScrub): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  let removed = false;
  const type = record["type"];
  if (typeof type === "string" && scrub.blockTypes.includes(type)) {
    for (const field of scrub.fields) {
      if (field in record) {
        delete record[field];
        removed = true;
      }
    }
  }
  for (const child of Object.values(record)) {
    if (removeFields(child, scrub)) removed = true;
  }
  return removed;
}
