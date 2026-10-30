// The byte ranges of a run's stored output (0005, 0009), as `work.output` and `work.outputRange`
// carry them: offsets count bytes of the stored output, the text is their UTF-8 decoding, and the
// engine's markers are flagged by their own byte ranges (DIPO-95). The TUI's output pane and
// `dipo watch` both cut a range here, so only the engine's flag ever draws a marker.

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

/** One byte range of stored output. */
export interface OutputRange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** The engine markers in or overlapping the range (DIPO-95). */
  readonly markers?: readonly OutputMarker[] | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 length of `text` in bytes. */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** The text of `range` from the byte offset `at` of the stored output on. */
export function textFrom(range: Pick<OutputRange, "from" | "text">, at: number): string {
  const skip = at - range.from;
  if (skip <= 0) return range.text;
  return decoder.decode(encoder.encode(range.text).subarray(skip));
}

/**
 * `text`, which starts at byte `start` of the stored output, cut at the flagged markers: the text
 * before, between and after them, and each marker that reaches into the text in its place, in
 * order. A marker's own bytes are not part of any text piece. Empty text pieces are left out.
 */
export function outputPieces(
  text: string,
  start: number,
  markers: readonly OutputMarker[],
): (string | OutputMarker)[] {
  if (markers.length === 0) return text === "" ? [] : [text];
  const bytes = encoder.encode(text);
  const inside = markers
    .filter((marker) => marker.to > start && marker.from < start + bytes.length)
    .toSorted((a, b) => a.from - b.from);
  if (inside.length === 0) return text === "" ? [] : [text];
  const pieces: (string | OutputMarker)[] = [];
  const push = (piece: string) => {
    if (piece !== "") pieces.push(piece);
  };
  let at = 0;
  for (const marker of inside) {
    const from = Math.max(at, marker.from - start);
    push(decoder.decode(bytes.subarray(at, from)));
    pieces.push(marker);
    at = Math.min(bytes.length, Math.max(from, marker.to - start));
  }
  push(decoder.decode(bytes.subarray(at)));
  return pieces;
}
