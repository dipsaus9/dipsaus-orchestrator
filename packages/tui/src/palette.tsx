// The command palette (0009, DIPO-463): `:` or Ctrl-K, from anywhere in home. Its rows come from the
// key registry in `keys.ts` (the same table as the footer and the keys overlay): first the actions
// of the focused item, then settings, then navigation, each with its key. An action the item does
// not offer stays listed with its reason. The rows are pure data (`paletteRows`); the overlay
// draws them in a box over the body (`docs/design/tui-v2/screens/09-palette.txt`).

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { Colored, type Role } from "./colour";
import { type ActionId, type ActionView, KEY_TABLE, NAV_KEYS, type NavTo } from "./keys";
import type { Display } from "./options";

/** What the palette needs to know about the focused item. */
export interface PaletteFocus {
  /** The view the item is in; none when nothing is focused. */
  readonly view: ActionView | null;
  /** The label the ON group is named after, such as `DIPO-447`; null without a focus. */
  readonly label: string | null;
  /** What kind of item it is, such as `MERGE`, for the keys overlay's title. */
  readonly kind: string | null;
  /** The story the item is about; the story verbs stay listed, off, when it is not parked. */
  readonly story: string | null;
  /** The commands the item offers. */
  readonly commands: ReadonlySet<string>;
  /** A worker is running for the item's story. */
  readonly running: boolean;
  /** The command lines of the item's actions no key sends. */
  readonly typed: readonly string[];
}

/** No item has the focus. */
export const NO_FOCUS: PaletteFocus = {
  view: null,
  label: null,
  kind: null,
  story: null,
  commands: new Set(),
  running: false,
  typed: [],
};

/** What a chosen row does. */
export type PaletteRun =
  | { readonly kind: "action"; readonly id: ActionId }
  | { readonly kind: "settings" }
  | { readonly kind: "go"; readonly to: NavTo };

export type PaletteGroup = "on" | "settings" | "goto";

export interface PaletteRow {
  readonly group: PaletteGroup;
  readonly label: string;
  /** The key that does the same; null when none does (stopping a run). */
  readonly key: string | null;
  /** Why the row cannot run now; null when it can. */
  readonly disabled: string | null;
  readonly run: PaletteRun;
}

/** The verbs that stay listed, off, for a story that does not offer them. */
const STORY_VERBS: readonly ActionId[] = ["resume", "test", "park", "drop", "discard"];

const capital = (text: string) => text.slice(0, 1).toUpperCase() + text.slice(1);

/** The actions of the focused item, in the registry's order, with a reason for each that is off. */
export function itemRows(focus: PaletteFocus, offline: boolean): PaletteRow[] {
  if (focus.view === null) return [];
  const view = focus.view;
  const ctx = { commands: focus.commands };
  const rows: PaletteRow[] = [];
  const seen = new Set<string>();
  for (const entry of KEY_TABLE) {
    if (!entry.views.includes(view)) continue;
    const offered = entry.when(ctx);
    if (!offered && !(focus.story !== null && STORY_VERBS.includes(entry.id))) continue;
    if (seen.has(`${entry.id}:${entry.key}`)) continue;
    seen.add(`${entry.id}:${entry.key}`);
    rows.push({
      group: "on",
      label: capital(entry.label),
      key: entry.key,
      disabled: offline ? "offline" : offered ? null : (entry.why ?? "not here"),
      run: { kind: "action", id: entry.id },
    });
  }
  if (focus.story !== null) {
    const stop = KEY_TABLE.find((entry) => entry.id === "stop");
    rows.push({
      group: "on",
      label: capital(stop?.label ?? "stop run"),
      key: null,
      disabled: offline ? "offline" : focus.running ? null : (stop?.why ?? "no run is going"),
      run: { kind: "action", id: "stop" },
    });
  }
  return rows;
}

/** Every row of the palette in its order: the item's actions, settings, then navigation. */
export function paletteRows(focus: PaletteFocus, offline: boolean): PaletteRow[] {
  return [
    ...itemRows(focus, offline),
    {
      group: "settings",
      label: "Privacy: what dipo stores…",
      key: null,
      disabled: null,
      run: { kind: "settings" },
    },
    ...NAV_KEYS.map((nav): PaletteRow => ({
      group: "goto",
      label: nav.id === "offices" ? nav.label : `Go to ${nav.label.toLowerCase()}`,
      key: nav.key,
      disabled: null,
      run: { kind: "go", to: nav.id },
    })),
  ];
}

/**
 * The positions of `query` in `text` as a case-insensitive subsequence, the tightest one (the
 * fewest characters from the first match to the last, then the earliest); null when it does not
 * match. An empty query matches at no position.
 */
export function fuzzyMatch(query: string, text: string): number[] | null {
  const needle = query.toLowerCase().replaceAll(" ", "");
  const hay = text.toLowerCase();
  if (needle === "") return [];
  let best: number[] | null = null;
  for (
    let start = hay.indexOf(needle[0] ?? "");
    start !== -1;
    start = hay.indexOf(needle[0] ?? "", start + 1)
  ) {
    const at = [start];
    let from = start + 1;
    for (const char of needle.slice(1)) {
      const next = hay.indexOf(char, from);
      if (next === -1) break;
      at.push(next);
      from = next + 1;
    }
    if (at.length !== needle.length) continue;
    const span = (at.at(-1) ?? 0) - start;
    const bestSpan = best === null ? Infinity : (best.at(-1) ?? 0) - (best[0] ?? 0);
    if (span < bestSpan) best = at;
  }
  return best;
}

/** A row with the positions of the query in its label. */
export interface Shown {
  readonly row: PaletteRow;
  readonly at: readonly number[];
}

/**
 * The rows `query` matches. The groups keep their order (the item's actions first); inside a
 * group the tighter match, then the earlier one, comes first. An empty query lists every row.
 */
export function filterRows(rows: readonly PaletteRow[], query: string): Shown[] {
  const scored = rows.flatMap((row, order) => {
    const at = fuzzyMatch(query, row.label);
    if (at === null) return [];
    const span = at.length === 0 ? 0 : (at.at(-1) ?? 0) - (at[0] ?? 0);
    return [{ row, at, order, span, start: at[0] ?? 0 }];
  });
  const rank: Record<PaletteGroup, number> = { on: 0, settings: 1, goto: 2 };
  scored.sort(
    (a, b) =>
      rank[a.row.group] - rank[b.row.group] ||
      a.span - b.span ||
      a.start - b.start ||
      a.order - b.order,
  );
  return scored.map(({ row, at }) => ({ row, at }));
}

/** The box: 62 columns of text, a space either side of them and the border. */
export const OVERLAY_INNER = 62;

/** Box-drawing characters; plain ones on an ASCII display. */
export function boxGlyphs(ascii: boolean) {
  return ascii
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", cursor: "_" }
    : { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", cursor: "▍" };
}

/** A piece of a line and the role it is painted in. */
export interface Seg {
  readonly text: string;
  readonly role?: Role;
  readonly underline?: boolean;
  /** On the focused row's background. */
  readonly sel?: boolean;
}

export const seg = (text: string, role?: Role, underline?: boolean): Seg => ({
  text,
  ...(role === undefined ? {} : { role }),
  ...(underline === undefined ? {} : { underline }),
});

/** The width of a line of segments. */
export const segWidth = (segs: readonly Seg[]) =>
  segs.reduce((sum, part) => sum + [...part.text].length, 0);

/** `segs` cut or padded to `width` cells. */
export function fit(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let left = width;
  for (const part of segs) {
    const chars = [...part.text];
    if (chars.length >= left) {
      out.push({ ...part, text: chars.slice(0, left).join("") });
      return out;
    }
    out.push(part);
    left -= chars.length;
  }
  out.push(seg(" ".repeat(left)));
  return out;
}

/** A line of segments. */
export function SegLine(props: { display: Display; segs: readonly Seg[] }) {
  return (
    <Text>
      {props.segs.map((part, i) => {
        const text = (
          <Colored display={props.display} role={part.role} underline={part.underline === true}>
            {part.text}
          </Colored>
        );
        return part.sel === true ? (
          <Colored key={i} display={props.display} role="sel">
            {text}
          </Colored>
        ) : (
          <Text key={i}>{text}</Text>
        );
      })}
    </Text>
  );
}

/**
 * Lines drawn in a box with an acc border, centred in `columns`: the box is `inner` columns of
 * text and two spaces either side.
 */
export function Overlay(props: {
  readonly display: Display;
  readonly columns: number;
  readonly inner: number;
  readonly lines: readonly (readonly Seg[])[];
}) {
  const { display, inner } = props;
  const g = boxGlyphs(display.ascii);
  const width = inner + 4;
  const margin = Math.max(0, Math.floor((props.columns - width - 2) / 2));
  const border = (left: string, right: string): Seg[] => [
    seg(left + g.h.repeat(width) + right, "acc"),
  ];
  const row = (children: ReactNode, key: string | number) => (
    <Box key={key} marginLeft={margin}>
      {children}
    </Box>
  );
  return (
    <Box flexDirection="column">
      {row(<SegLine display={display} segs={border(g.tl, g.tr)} />, "top")}
      {props.lines.map((line, i) =>
        row(
          <SegLine
            display={display}
            segs={[seg(g.v, "acc"), seg("  "), ...fit(line, inner), seg("  "), seg(g.v, "acc")]}
          />,
          i,
        ),
      )}
      {row(<SegLine display={display} segs={border(g.bl, g.br)} />, "bottom")}
    </Box>
  );
}

/** The rule between the parts of an overlay. */
export const rule = (inner: number): Seg[] => [seg("─".repeat(inner), "faint")];

/** The segments of a label with the matched positions underlined. */
function labelSegs(label: string, at: readonly number[], role: Role): Seg[] {
  return [...label].map((char, i) => seg(char, role, at.includes(i)));
}

/** The lines of the palette's box. */
export function paletteLines(
  shown: readonly Shown[],
  query: string,
  index: number,
  focus: PaletteFocus,
  display: Display,
): Seg[][] {
  const g = boxGlyphs(display.ascii);
  const bar = display.ascii ? ">" : "▌";
  const lines: Seg[][] = [
    [seg(": ", "acc"), seg(query, "hi"), seg(g.cursor, "acc")],
    rule(OVERLAY_INNER),
  ];
  const heading: Record<PaletteGroup, string> = {
    on: focus.label === null ? "" : `ON ${focus.label}`,
    settings: "SETTINGS",
    goto: "GO TO",
  };
  let last: PaletteGroup | null = null;
  shown.forEach(({ row, at }, i) => {
    if (row.group !== last) {
      last = row.group;
      if (heading[row.group] !== "") lines.push([seg(heading[row.group], "dim")]);
    }
    const selected = i === index;
    const off = row.disabled !== null;
    const right = off ? (row.disabled ?? "") : (row.key ?? "");
    const left = [
      seg(selected ? bar : " ", "acc"),
      seg(" "),
      ...labelSegs(row.label, at, off ? "faint" : "hi"),
    ];
    const gap = Math.max(1, OVERLAY_INNER - segWidth(left) - [...right].length - 1);
    const rowSegs = [...left, seg(" ".repeat(gap)), seg(right, off ? "dim" : "acc"), seg(" ")];
    lines.push(
      selected
        ? fit(rowSegs, OVERLAY_INNER).map((part) => ({ ...part, sel: true }))
        : fit(rowSegs, OVERLAY_INNER),
    );
  });
  if (shown.length === 0) lines.push([seg("No command matches.", "dim")]);
  lines.push(rule(OVERLAY_INNER));
  lines.push([
    seg("⏎", "acc"),
    seg(" run   ", "dim"),
    seg("↑↓", "acc"),
    seg(" choose   ", "dim"),
    seg("esc", "acc"),
    seg(" close", "dim"),
  ]);
  return lines;
}

/** The command palette over the body. */
export function Palette(props: {
  readonly display: Display;
  readonly columns: number;
  readonly shown: readonly Shown[];
  readonly query: string;
  readonly index: number;
  readonly focus: PaletteFocus;
}) {
  return (
    <Overlay
      display={props.display}
      columns={props.columns}
      inner={OVERLAY_INNER}
      lines={paletteLines(props.shown, props.query, props.index, props.focus, props.display)}
    />
  );
}
