// The mouse (0009, DIPO-515): SGR 1006 press and wheel reports, read from stdin beside Ink. Ink
// drops each CSI sequence it cannot map to a key before `useInput`, so a report never reaches the
// key handler; `useMouse` listens to stdin's data events, which see every chunk Ink reads without
// taking it away. Reporting is press, release and wheel only (`?1000`), in SGR form (`?1006`), with
// no drag or motion. The Desk is the one screen that acts on it (`desk.tsx`, `home.tsx`).

import { useStdin } from "ink";
import { useEffect, useRef } from "react";

/** Two clicks on the same row within this long are a double click. */
export const DOUBLE_CLICK_MS = 400;

/** The rows one wheel step scrolls a preview by. */
export const WHEEL_ROWS = 3;

/** One report: `x` and `y` count from 1, the top left cell. */
export interface MouseEvent {
  readonly kind: "press" | "release" | "wheelUp" | "wheelDown";
  readonly x: number;
  readonly y: number;
}

const ESC = String.fromCharCode(27);
const REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

/** The end of a chunk that may be the start of a report: the rest comes with the next read. */
const PARTIAL = new RegExp(`${ESC}(?:\\[(?:<[\\d;]*)?)?$`);
/** The longest report is far shorter; a longer tail is not one. */
const MAX_PARTIAL = 24;

/** Left button and wheel only; the bits of shift, meta and ctrl (4, 8, 16) are ignored. */
function eventOf(code: number, x: number, y: number, final: string): MouseEvent | null {
  const button = code & ~(4 | 8 | 16);
  if (button === 64) return final === "M" ? { kind: "wheelUp", x, y } : null;
  if (button === 65) return final === "M" ? { kind: "wheelDown", x, y } : null;
  if (button === 0) return { kind: final === "M" ? "press" : "release", x, y };
  return null;
}

/** A parser that keeps what a read left unfinished and joins it to the next. */
export class MouseParser {
  #rest = "";

  /** The events in `chunk`, after whatever the reads before it left. */
  feed(chunk: string): MouseEvent[] {
    const text = this.#rest + chunk;
    const events: MouseEvent[] = [];
    let end = 0;
    for (const match of text.matchAll(REPORT)) {
      end = match.index + match[0].length;
      const event = eventOf(Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? "");
      if (event !== null) events.push(event);
    }
    const tail = text.slice(end);
    const partial = PARTIAL.exec(tail);
    this.#rest = partial !== null && tail.length - partial.index <= MAX_PARTIAL ? partial[0] : "";
    return events;
  }
}

/** Calls `handler` for every report that arrives on stdin; the handler of the latest render. */
export function useMouse(handler: (event: MouseEvent) => void): void {
  const { stdin } = useStdin();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const parser = new MouseParser();
    const onData = (chunk: Buffer | string) => {
      for (const event of parser.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8")))
        latest.current(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);
}

/** One button of a preview, in body rows and cells counted from 0. */
export interface HitButton {
  readonly row: number;
  readonly from: number;
  readonly to: number;
  readonly key: string;
}

/** Where the Desk drew its parts, in body rows and cells counted from 0 (`desk.tsx`). */
export interface DeskHitMap {
  /** The list item each body row shows, null for a heading, a blank or a band. */
  readonly listRows: readonly (number | null)[];
  /** Cells left of this are the list, none when the preview fills the body. */
  readonly listWidth: number;
  /** The first cell of the preview pane, null when none shows. */
  readonly previewX: number | null;
  /** The last first row the preview scrolls to. */
  readonly previewMax: number;
  readonly buttons: readonly HitButton[];
}

/** What a report points at on the Desk. `bodyTop` is the screen row (from 1) of the body's first. */
export type DeskHit =
  | { readonly area: "list"; readonly item: number | null }
  | { readonly area: "preview"; readonly button: string | null };

export function deskHit(map: DeskHitMap, bodyTop: number, event: MouseEvent): DeskHit | null {
  const row = event.y - bodyTop;
  const col = event.x - 1;
  if (row < 0 || col < 0) return null;
  if (col < map.listWidth) return { area: "list", item: map.listRows[row] ?? null };
  if (map.previewX === null || col < map.previewX) return null;
  const hit = map.buttons.find((b) => b.row === row && col >= b.from && col < b.to);
  return { area: "preview", button: hit?.key ?? null };
}
