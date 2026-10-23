// The text behind one output pane of the live agent detail (0009 sections 4 and 9, 0005 sections 5
// and 7): one run's stored output of one source, held outside React. It loads the tail with
// `work.outputRange`, appends `work.output` byte ranges as they arrive, reads the gap when one was
// missed, and reads earlier text when the pane scrolls past what it holds. Offsets count bytes in
// the stored output; the text held always starts at a line start, so every line shown is whole.
// While the pane follows the tail it keeps about `tailBytes`; scrolled back it keeps what it read.
// The engine's phase markers come flagged with their byte ranges (DIPO-95); the feed keeps the
// flags of the text it holds and turns each flagged range into one marker line, so only the engine
// can draw a marker: worker text that reads like one stays text.

import { cleanText, type EngineError, type OutputMarker } from "@dipsaus-orchestrator/contract";

/** One byte range of stored output, as `work.output` and `work.outputRange` carry it. */
export interface OutputRange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** The engine markers in or overlapping the range (DIPO-95). */
  readonly markers?: readonly OutputMarker[] | undefined;
}

/** A held line: text as stored, or an engine marker drawn from its flag. */
export type OutputLine = string | OutputMarker;

export type RangeOutcome =
  | { readonly ok: true; readonly result: OutputRange }
  | { readonly ok: false; readonly error: EngineError };

/** `work.outputRange` for this pane's run and source; `to` absent reads to the end. */
export type RangeRead = (from: number, to?: number) => Promise<RangeOutcome>;

/** What changed: text after the end, text before the start, or everything. */
export type FeedChange = "append" | "prepend" | "reset";

/** The bytes the pane keeps while it follows the tail, and reads per step back. */
export const OUTPUT_TAIL_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * One stored line as the pane shows it: cleaned of terminal control characters by the shared
 * cleaner (DIPO-313), tabs as spaces, the last `\r` frame only.
 */
export function cleanLine(line: string): string {
  // The cleaner turns a carriage return into a line end, so the frames split on it.
  const frames = cleanText(line).split("\n");
  const last = frames.findLast((frame) => frame !== "") ?? "";
  return last.replaceAll("\t", "  ");
}

/** `text` split into lines; a final newline ends the last line rather than starting one. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(cleanLine);
}

/**
 * The held `text`, which starts at byte `start` of the stored output, as lines: each flagged
 * marker range becomes one marker line and the text around it splits as usual. A marker that
 * begins inside a line ends that line first.
 */
export function heldLines(
  text: string,
  start: number,
  markers: readonly OutputMarker[],
): OutputLine[] {
  if (markers.length === 0) return splitLines(text);
  const bytes = encoder.encode(text);
  const inside = markers
    .filter((marker) => marker.to > start && marker.from < start + bytes.length)
    .toSorted((a, b) => a.from - b.from);
  if (inside.length === 0) return splitLines(text);
  const lines: OutputLine[] = [];
  let at = 0;
  for (const marker of inside) {
    const from = Math.max(at, marker.from - start);
    lines.push(...splitLines(decoder.decode(bytes.subarray(at, from))), marker);
    at = Math.min(bytes.length, Math.max(from, marker.to - start));
  }
  lines.push(...splitLines(decoder.decode(bytes.subarray(at))));
  return lines;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** True for an engine marker line. */
export function isMarker(line: OutputLine): line is OutputMarker {
  return typeof line !== "string";
}

/**
 * An engine marker as a rule: `── 12:04:31 phase: verify ──` or `── 12:09:02 run ended: in-review
 * ──` (local time; `--` in ASCII mode). `dipo watch` prints the same rule.
 */
export function markerRule(marker: OutputMarker, ascii = false): string {
  const at = new Date(marker.at);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  const rule = ascii ? "--" : "──";
  const label =
    marker.kind === "phase"
      ? `phase: ${marker.value}`
      : marker.kind === "ended"
        ? `run ended: ${marker.value}`
        : `${marker.kind}: ${marker.value}`;
  return `${rule} ${time} ${label} ${rule}`;
}

/** A line as the pane shows it: an engine marker as its rule, any other line as is. */
export function displayLine(line: OutputLine, ascii = false): string {
  return isMarker(line) ? markerRule(line, ascii) : line;
}

/** The lines cut to `width` columns each, so the pane never scrolls sideways (0009 section 9). */
export function wrapLines(lines: readonly string[], width: number): string[] {
  const rows: string[] = [];
  const size = Math.max(1, width);
  for (const line of lines) {
    if (line.length <= size) {
      rows.push(line);
      continue;
    }
    for (let at = 0; at < line.length; at += size) rows.push(line.slice(at, at + size));
  }
  return rows;
}

/** How many rows `lines` take at `width` columns. */
export function rowCount(lines: readonly OutputLine[], width: number, ascii = false): number {
  const size = Math.max(1, width);
  let rows = 0;
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(displayLine(line, ascii).length / size));
  }
  return rows;
}

/**
 * The `height` rows on screen when the pane is scrolled `offset` rows up from the bottom: only
 * the lines that reach the screen are cut into rows, the rest of the held text is not touched.
 */
export function visibleRows(
  lines: readonly OutputLine[],
  width: number,
  height: number,
  offset: number,
  ascii = false,
): string[] {
  const rows: string[] = [];
  const wanted = height + offset;
  for (let i = lines.length - 1; i >= 0 && rows.length < wanted; i--) {
    rows.unshift(...wrapLines([displayLine(lines[i] ?? "", ascii)], width));
  }
  const end = Math.max(0, rows.length - offset);
  return rows.slice(Math.max(0, end - height), end);
}

/** The last non-empty text line of `lines`, trimmed, or null; engine markers never count. */
export function lastLine(lines: readonly OutputLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const held = lines[i];
    if (held === undefined || isMarker(held)) continue;
    const line = held.trim();
    if (line !== "") return line;
  }
  return null;
}

export class OutputFeed {
  readonly #read: RangeRead;
  readonly #tailBytes: number;
  readonly #onChange: (change: FeedChange) => void;
  #text = "";
  /** Byte offsets of `#text` in the stored output. */
  #start = 0;
  #end = 0;
  #lines: OutputLine[] | null = null;
  /** The engine marker flags of the held text, oldest first. */
  #markers: OutputMarker[] = [];
  #loaded = false;
  /** Nothing is stored before `#start` (it is 0, or an earlier read came back empty). */
  #atStart = false;
  /** A read is running; live ranges wait in `#queued` until it is done. */
  #busy = false;
  #queued: OutputRange[] = [];
  #following = true;
  #closed = false;
  #error: string | null = null;

  constructor(read: RangeRead, tailBytes: number, onChange: (change: FeedChange) => void) {
    this.#read = read;
    this.#tailBytes = Math.max(1, tailBytes);
    this.#onChange = onChange;
  }

  /** The held text as lines, oldest first. */
  get lines(): readonly OutputLine[] {
    this.#lines ??= heldLines(this.#text, this.#start, this.#markers);
    return this.#lines;
  }

  get start(): number {
    return this.#start;
  }

  get end(): number {
    return this.#end;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get atStart(): boolean {
    return this.#atStart || this.#start === 0;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** The last failed read, until the next one succeeds. */
  get error(): string | null {
    return this.#error;
  }

  /** Reads the stored output to its end, keeping the tail. Call once. */
  async load(): Promise<void> {
    this.#busy = true;
    await this.#readOn(true);
    if (this.#closed) return;
    this.#loaded = true;
    this.#busy = false;
    this.#onChange("reset");
    this.#drain();
  }

  /** A live `work.output` range of this run and source. */
  push(range: OutputRange): void {
    if (this.#closed) return;
    if (!this.#loaded || this.#busy) {
      this.#queued.push(range);
      return;
    }
    this.#apply(range);
  }

  /** Reads the text before what is held, one step of `tailBytes`; no-op at the start or busy. */
  async loadEarlier(): Promise<void> {
    if (!this.#loaded || this.#busy || this.atStart) return;
    this.#busy = true;
    const from = Math.max(0, this.#start - this.#tailBytes);
    const outcome = await this.#read(from, this.#start);
    if (this.#closed) return;
    this.#busy = false;
    if (!outcome.ok) {
      this.#error = `${outcome.error.code}: ${outcome.error.message}`;
      this.#onChange("prepend");
      this.#drain();
      return;
    }
    this.#error = null;
    const { result } = outcome;
    if (result.text === "" || result.to <= result.from) {
      // Nothing stored before: retention removed it, or it never existed.
      this.#atStart = true;
    } else {
      let text = result.text;
      let begin = result.from;
      if (begin > 0) {
        // The step may start inside a line: keep only whole lines; the rest comes with the next.
        const newline = text.indexOf("\n");
        if (newline !== -1 && newline < text.length - 1) {
          begin += byteLength(text.slice(0, newline + 1));
          text = text.slice(newline + 1);
        }
      }
      this.#text = text + this.#text;
      this.#addMarkers(result.markers);
      this.#start = begin;
      this.#lines = null;
    }
    this.#onChange("prepend");
    this.#drain();
  }

  /** Following keeps only the tail; scrolled back, nothing read is dropped. */
  setFollowing(following: boolean): void {
    this.#following = following;
    if (following && this.#trim(2 * this.#tailBytes)) this.#onChange("reset");
  }

  close(): void {
    this.#closed = true;
    this.#queued = [];
  }

  #apply(range: OutputRange): void {
    if (range.to <= this.#end) return;
    if (range.from > this.#end) {
      // A range was missed (sent before this pane subscribed, or dropped): read the gap.
      this.#queued.push(range);
      void this.#fill();
      return;
    }
    const skip = this.#end - range.from;
    const text =
      skip === 0 ? range.text : decoder.decode(encoder.encode(range.text).subarray(skip));
    this.#text += text;
    this.#addMarkers(range.markers);
    this.#end = range.to;
    this.#lines = null;
    if (this.#following) this.#trim(2 * this.#tailBytes);
    this.#onChange("append");
  }

  async #fill(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    await this.#readOn(false);
    if (this.#closed) return;
    this.#busy = false;
    this.#onChange("append");
    this.#drain();
  }

  /** Reads from the held end until a read comes back empty. */
  async #readOn(initial: boolean): Promise<void> {
    for (;;) {
      const outcome = await this.#read(this.#end);
      if (this.#closed) return;
      if (!outcome.ok) {
        this.#error = `${outcome.error.code}: ${outcome.error.message}`;
        return;
      }
      this.#error = null;
      const { result } = outcome;
      if (result.text === "" || result.to <= this.#end) return;
      if (initial && this.#text === "") this.#start = result.from;
      this.#text += result.text;
      this.#addMarkers(result.markers);
      this.#end = result.to;
      this.#lines = null;
      if (initial || this.#following) this.#trim(this.#tailBytes);
    }
  }

  /** Keeps the flags of `markers` not held yet, oldest first. */
  #addMarkers(markers: readonly OutputMarker[] | undefined): void {
    if (markers === undefined) return;
    for (const marker of markers) {
      if (this.#markers.some((held) => held.from === marker.from)) continue;
      this.#markers.push(marker);
    }
    this.#markers.sort((a, b) => a.from - b.from);
  }

  #drain(): void {
    while (!this.#busy && this.#queued.length > 0 && !this.#closed) {
      const range = this.#queued.shift();
      if (range !== undefined) this.#apply(range);
    }
  }

  /** Drops whole lines from the start until about `tailBytes` remain; true when it dropped. */
  #trim(limit: number): boolean {
    if (this.#end - this.#start <= limit) return false;
    const bytes = encoder.encode(this.#text);
    const cut = bytes.length - this.#tailBytes;
    let at = bytes.indexOf(0x0a, Math.max(0, cut - 1));
    if (at === -1 || at >= bytes.length - 1) return false;
    at += 1;
    this.#text = decoder.decode(bytes.subarray(at));
    this.#start += at;
    this.#markers = this.#markers.filter((marker) => marker.to > this.#start);
    this.#atStart = false;
    this.#lines = null;
    return true;
  }
}
