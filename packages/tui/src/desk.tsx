// Your desk (`3`, 0009 sections 4, 5 and 9, amended by DIPO-132 and DIPO-308): what waits on the
// maintainer, read from `office.desk` and shown in the engine's order. A count line, then one row
// per item with its kind, story, park reason and cause, detail, age and the keys its actions offer
// (`keys.ts`); the stories held by the maintainer are listed apart under "Held by you". An empty
// desk says `Nothing waits on you.`. At 80 columns and wider an item with a hand action or with
// stories it blocks gets a second line for them; below 80 every row is one line and the keys of
// the selected row show in the footer only.
//
// No event carries the desk, so `useDesk` reads `office.desk` again after every office event that
// can change it and after the store read the office again (a stream reset or a switch), at most
// once a second. The TUI never orders, filters or derives a desk item itself.

import type { OfficeStore } from "@dipsaus-orchestrator/client";
import type {
  Clock,
  DeskItem,
  EngineError,
  Event,
  OfficeId,
  TimerHandle,
} from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import { age, truncate } from "./format";
import { rowKeys } from "./keys";
import type { Display } from "./options";
import { glyphs } from "./views";

/** The narrowest terminal whose desk rows may take a second line (0009 section 9). */
export const DESK_WIDE_COLUMNS = 80;

/** The desk reads `office.desk` at most this often. */
export const DESK_READ_INTERVAL_MS = 1_000;

/** Said by an empty desk. */
export const EMPTY_DESK = "Nothing waits on you.";

/** The office events after which the desk may have changed (DIPO-308). */
export const DESK_EVENTS: ReadonlySet<string> = new Set([
  "story.parked",
  "gate.reached",
  "gate.decided",
  "question.asked",
  "question.closed",
  "test.started",
  "test.recorded",
  "proposal.filed",
  "proposal.closed",
  "story.pr",
  "work.phase",
]);

/** True when `event` can change the desk: a desk event, or a story leaving Parked. */
export function changesDesk(event: Event): boolean {
  if (DESK_EVENTS.has(event.type)) return true;
  if (event.type !== "story.state") return false;
  const data = event.data as { from?: unknown; to?: unknown };
  return data.from === "Parked" && data.to !== "Parked";
}

export type DeskOutcome =
  | { readonly ok: true; readonly result: readonly DeskItem[] }
  | { readonly ok: false; readonly error: EngineError };

export type ReadDesk = (office: OfficeId) => Promise<DeskOutcome>;

/** What the desk view shows: the last items read, or why none could be. */
export interface DeskState {
  readonly items: readonly DeskItem[] | null;
  readonly error: EngineError | null;
}

/**
 * Reads `office.desk` while `active`: once when it starts, then after each desk-changing event of
 * the office and after each snapshot the store applies, at most once per `DESK_READ_INTERVAL_MS`.
 * A read answered for another office than the open one is dropped.
 */
export function useDesk(options: {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly readDesk: ReadDesk;
  readonly office: OfficeId | null;
  readonly active: boolean;
  readonly snapshots: number;
}): DeskState {
  const { store, clock, readDesk, office, active, snapshots } = options;
  const [state, setState] = useState<DeskState>({ items: null, error: null });
  // The pacing: a read starts a quiet interval; a change in it reads once more at its end.
  const pacing = useRef<{ timer: TimerHandle | null; again: boolean }>({
    timer: null,
    again: false,
  });

  useEffect(() => {
    setState({ items: null, error: null });
  }, [office]);

  useEffect(() => {
    if (!active || office === null) return;
    let stopped = false;
    const pace = pacing.current;
    const read = () => {
      pace.again = false;
      pace.timer = clock.setTimeout(() => {
        pace.timer = null;
        if (!stopped && pace.again) read();
      }, DESK_READ_INTERVAL_MS);
      void readDesk(office).then((outcome) => {
        if (stopped || store.state.office !== office) return;
        setState(
          outcome.ok
            ? { items: outcome.result, error: null }
            : (previous) => ({ items: previous.items, error: outcome.error }),
        );
      });
    };
    const request = () => {
      if (pace.timer === null) read();
      else pace.again = true;
    };
    request();
    const stop = store.onOfficeEvent((event) => {
      if (changesDesk(event)) request();
    });
    return () => {
      stopped = true;
      stop();
      if (pace.timer !== null) clock.clearTimeout(pace.timer);
      pace.timer = null;
      pace.again = false;
    };
  }, [store, clock, readDesk, office, active, snapshots]);

  return state;
}

/** The identity of a desk row, so the selection follows it when the desk is read again. */
export function deskRowId(item: DeskItem): string {
  return [
    item.kind,
    item.key ?? "",
    item.question ?? "",
    item.gate ?? "",
    item.proposal?.id ?? "",
    item.pr?.number ?? "",
  ].join(":");
}

/** The desk's rows in the engine's order: what waits, then the stories held by the maintainer. */
export function deskRows(items: readonly DeskItem[]): {
  readonly waiting: readonly DeskItem[];
  readonly held: readonly DeskItem[];
  /** Both lists in display order: the order `j` and `k` move in. */
  readonly all: readonly DeskItem[];
} {
  const waiting = items.filter((item) => item.kind !== "HELD");
  const held = items.filter((item) => item.kind === "HELD");
  return { waiting, held, all: [...waiting, ...held] };
}

/** The selected row: by its id, else the first row of the same story, else the same index. */
export function selectedRow(
  rows: readonly DeskItem[],
  selection: { readonly id: string | null; readonly key: string | null; readonly index: number },
): number {
  if (rows.length === 0) return -1;
  const byId = rows.findIndex((item) => deskRowId(item) === selection.id);
  if (byId !== -1) return byId;
  const byKey = selection.key === null ? -1 : rows.findIndex((item) => item.key === selection.key);
  if (byKey !== -1) return byKey;
  return Math.max(0, Math.min(rows.length - 1, selection.index));
}

/** `needs-permission (build)` for a park; empty for an item that is no park. */
export function parkWords(item: DeskItem): string {
  if (item.reason === undefined) return "";
  return item.cause === undefined ? item.reason : `${item.reason} (${item.cause})`;
}

/** The key hints of a row, as the footer and wide rows show them. */
export function rowHints(item: DeskItem, capabilities: readonly string[]): string {
  return rowKeys(item, capabilities)
    .bound.map((entry) => entry.binding.hint)
    .join(" ");
}

/** One desk row's lines; the first is the row, a second (wide only) its hand action or blocks. */
export function rowLines(options: {
  readonly item: DeskItem;
  readonly selected: boolean;
  /** Column widths; `hints` is the widest key hint of the rows, 0 below 80 columns. */
  readonly widths: { readonly kind: number; readonly story: number; readonly hints: number };
  readonly columns: number;
  readonly now: number;
  readonly capabilities: readonly string[];
  readonly display: Display;
}): string[] {
  const { item, widths, columns, now, display } = options;
  const { dot, ellipsis } = glyphs(display.ascii);
  const wide = columns >= DESK_WIDE_COLUMNS;
  const marker = options.selected ? ">" : " ";
  const head = `${marker} ${item.kind.padEnd(widths.kind)} ${(item.story ?? "").padEnd(widths.story)}`;
  const park = parkWords(item);
  const middle = park === "" ? item.detail : `${park} ${dot} ${item.detail}`;
  const when = age(now - Date.parse(item.since));
  const hints = wide ? rowHints(item, options.capabilities) : "";
  const tail = `  ${when.padStart(3)}${widths.hints === 0 ? "" : `  ${hints.padEnd(widths.hints)}`}`;
  const room = Math.max(0, columns - 1 - head.length - 2 - tail.length);
  const lines = [`${head}  ${truncate(middle, room, ellipsis).padEnd(room)}${tail}`];
  if (wide) {
    const extra: string[] = [];
    if (item.hand !== undefined) extra.push(`by hand: ${item.hand}`);
    if (item.blocks.length > 0) extra.push(`blocks ${item.blocks.join(", ")}`);
    if (extra.length > 0) {
      const indent = " ".repeat(2 + widths.kind + 1);
      lines.push(truncate(`${indent}${extra.join(` ${dot} `)}`, columns - 1, ellipsis));
    }
  }
  return lines;
}

export function Desk(props: {
  readonly desk: DeskState;
  /** True when the engine has `office.desk` (capability `desk`). */
  readonly available: boolean;
  /** The selected row in `deskRows(...).all`, -1 for none. */
  readonly selected: number;
  readonly columns: number;
  readonly height: number;
  readonly now: number;
  readonly capabilities: readonly string[];
  readonly display: Display;
}) {
  const { desk, columns, display } = props;
  const { ellipsis } = glyphs(display.ascii);
  const line = (text: string, key: string, tone?: "selected" | "title") => {
    const shown = truncate(text, columns - 1, ellipsis);
    if (!display.color || tone === undefined) {
      return (
        <Text key={key} wrap="truncate-end">
          {` ${shown}`}
        </Text>
      );
    }
    return tone === "title" ? (
      <Text key={key} bold wrap="truncate-end">
        {` ${shown}`}
      </Text>
    ) : (
      <Text key={key} color="cyan" wrap="truncate-end">
        {` ${shown}`}
      </Text>
    );
  };
  if (!props.available) {
    return (
      <Box flexDirection="column">
        {line("Your desk", "title", "title")}
        {line(
          "This daemon has no office.desk read (capability desk); restart it with this binary.",
          "missing",
        )}
      </Box>
    );
  }
  if (desk.items === null) {
    return (
      <Box flexDirection="column">
        {line("Your desk", "title", "title")}
        {line(
          desk.error === null
            ? `reading the desk${ellipsis}`
            : `desk: ${desk.error.code}: ${desk.error.message}`,
          "status",
        )}
      </Box>
    );
  }
  const { waiting, held, all } = deskRows(desk.items);
  const widths = {
    kind: Math.max(0, ...all.map((item) => item.kind.length)),
    story: Math.max(0, ...all.map((item) => (item.story ?? "").length)),
    hints:
      columns >= DESK_WIDE_COLUMNS
        ? Math.max(0, ...all.map((item) => rowHints(item, props.capabilities).length))
        : 0,
  };
  const rendered = all.map((item, i) =>
    rowLines({
      item,
      selected: i === props.selected,
      widths,
      columns,
      now: props.now,
      capabilities: props.capabilities,
      display,
    }),
  );
  const out: { text: string; key: string; tone?: "selected" | "title" }[] = [];
  out.push({ text: `Your desk (${waiting.length})`, key: "count", tone: "title" });
  if (desk.error !== null) {
    out.push({ text: `desk: ${desk.error.code}: ${desk.error.message}`, key: "error" });
  }
  if (waiting.length === 0) out.push({ text: EMPTY_DESK, key: "empty" });
  // The rows with "Held by you" before the first held one, then a window that keeps the selected
  // row on screen.
  const body: { text: string; key: string; tone?: "selected" | "title"; row: number }[] = [];
  rendered.forEach((lines, i) => {
    if (i === waiting.length) {
      body.push({ text: `Held by you (${held.length})`, key: "held", tone: "title", row: i });
    }
    const id = deskRowId(all[i]!);
    lines.forEach((text, n) => {
      const selected = i === props.selected && n === 0;
      body.push({ text, key: `${id}:${n}`, row: i, ...(selected ? { tone: "selected" } : {}) });
    });
  });
  const room = Math.max(1, props.height - out.length);
  const last = body.findLastIndex((entry) => entry.row === props.selected);
  const start = Math.max(0, last - room + 1);
  out.push(...body.slice(start, start + room));
  return (
    <Box flexDirection="column">{out.map((entry) => line(entry.text, entry.key, entry.tone))}</Box>
  );
}
