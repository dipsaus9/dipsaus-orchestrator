// The run's event file `events.ndjson` (0006 decision 8, 0007 section 5). The host appends one
// `{ t, ch, data }` line per worker stdout line, stderr line, hook payload and exit, in the 0017
// recording envelope; `data` is the text the adapter's `interpret` reads. Offsets are byte
// offsets into the file and only grow: each append returns the offset after it, which the engine
// stores as `processed_offset` once it has applied those bytes.

import { closeSync, fstatSync, openSync, writeSync } from "node:fs";

import type { HostLine } from "../workers/types";

export type EventChannel = "stdout" | "stderr" | "hook" | "exit";

/** The longest line the host holds while waiting for its newline (4 MiB). */
export const MAX_PENDING_LINE = 4 * 1024 * 1024;

export class EventLog {
  readonly path: string;
  #fd: number | null;
  #offset: number;

  private constructor(path: string, fd: number, offset: number) {
    this.path = path;
    this.#fd = fd;
    this.#offset = offset;
  }

  /** Opens `path` for appending (mode 0600); offsets continue from its current size. */
  static open(path: string): EventLog {
    const fd = openSync(path, "a", 0o600);
    return new EventLog(path, fd, fstatSync(fd).size);
  }

  /** Size of the file after the last append. */
  get offset(): number {
    return this.#offset;
  }

  /** Appends one line and returns the offset after it. */
  append(line: HostLine): number {
    if (this.#fd === null) throw new Error("the event file is closed");
    const bytes = Buffer.from(`${JSON.stringify({ t: line.t, ch: line.ch, data: line.data })}\n`);
    let written = 0;
    while (written < bytes.byteLength) {
      written += writeSync(this.#fd, bytes, written, bytes.byteLength - written);
    }
    this.#offset += bytes.byteLength;
    return this.#offset;
  }

  close(): void {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
  }
}

/**
 * Splits stream text into lines, each with its newline, holding a partial last line until it
 * completes. `flush` returns that partial line at the end of the stream.
 */
export class LineSplitter {
  readonly #decoder = new TextDecoder();
  readonly #maxPending: number;
  #pending = "";

  /**
   * `maxPending` caps the held partial line (in UTF-16 code units, about its bytes for stream
   * JSON): a longer line is emitted in pieces of that size, each its own event, so a worker that
   * never writes a newline cannot grow the host's memory.
   */
  constructor(maxPending: number = MAX_PENDING_LINE) {
    this.#maxPending = maxPending;
  }

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    const all = this.#pending + text;
    const lines: string[] = [];
    let start = 0;
    for (let at = all.indexOf("\n"); at >= 0; at = all.indexOf("\n", start)) {
      for (; at + 1 - start > this.#maxPending; start += this.#maxPending) {
        lines.push(all.slice(start, start + this.#maxPending));
      }
      lines.push(all.slice(start, at + 1));
      start = at + 1;
    }
    for (; all.length - start > this.#maxPending; start += this.#maxPending) {
      lines.push(all.slice(start, start + this.#maxPending));
    }
    this.#pending = all.slice(start);
    return lines;
  }

  /** The partial last line, or null; the splitter is empty afterwards. */
  flush(): string | null {
    const rest = this.#pending + this.#decoder.decode();
    this.#pending = "";
    return rest === "" ? null : rest;
  }
}
