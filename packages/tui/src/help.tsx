// The keys overlay (0009, DIPO-463): `?`. It lists the keys of the focused item, movement and the
// global keys from the same registry as the footer and the palette (`keys.ts`, `palette.tsx`),
// laid out as `docs/design/tui-v2/screens/13-keys-overlay.txt`. Typing filters it; Enter hands the
// typed text to the palette.

import { GLOBAL_KEYS, MOVE_KEYS } from "./keys";
import type { Display } from "./options";
import {
  boxGlyphs,
  fuzzyMatch,
  itemRows,
  Overlay,
  type PaletteFocus,
  rule,
  type Seg,
  seg,
  segWidth,
} from "./palette";

/** Text inside the box. */
export const HELP_INNER = 90;
/** The left column takes this many cells; the right one the rest. */
const LEFT = 52;

const VIEW_NAMES: Readonly<Record<string, string>> = {
  desk: "Desk",
  overview: "Overview",
  queue: "Queue",
  detail: "Run",
  checklist: "Checklist",
};

/** The title: `KEYS · Desk · on a MERGE item`. */
export function helpTitle(focus: PaletteFocus, display: Display): string {
  const dot = display.ascii ? "-" : "·";
  const view = focus.view === null ? "" : (VIEW_NAMES[focus.view] ?? "");
  const on = focus.kind === null ? "" : ` ${dot} on a ${focus.kind} item`;
  return `KEYS${view === "" ? "" : ` ${dot} ${view}`}${on}`;
}

/** The keys one line of the overlay shows, for the test that holds the overlay to the registry. */
export interface HelpKeys {
  readonly item: readonly {
    readonly key: string;
    readonly label: string;
    readonly off: string | null;
  }[];
  readonly typed: readonly string[];
  readonly move: readonly { readonly key: string; readonly label: string }[];
  readonly global: readonly { readonly key: string; readonly label: string }[];
}

/** What the overlay lists for `focus` and `query`, before it is laid out. */
export function helpKeys(focus: PaletteFocus, offline: boolean, query: string): HelpKeys {
  const matches = (label: string) => fuzzyMatch(query, label) !== null;
  return {
    item: itemRows(focus, offline)
      .filter((row) => row.key !== null && matches(row.label))
      .map((row) => ({ key: row.key ?? "", label: row.label, off: row.disabled })),
    typed: focus.typed.filter((line) => matches(line)),
    move: MOVE_KEYS.filter((entry) => matches(entry.label)),
    global: GLOBAL_KEYS.filter((entry) => matches(entry.label)),
  };
}

/** The two columns as lines of segments. */
export function helpLines(
  focus: PaletteFocus,
  offline: boolean,
  query: string,
  display: Display,
): Seg[][] {
  const g = boxGlyphs(display.ascii);
  const keys = helpKeys(focus, offline, query);
  const dot = display.ascii ? "-" : "·";
  const left: Seg[][] = [];
  const right: Seg[][] = [];
  if (keys.item.length > 0) {
    left.push([seg("THIS ITEM", "dim")]);
    for (const entry of keys.item) {
      left.push(
        entry.off === null
          ? [seg(entry.key.padEnd(7), "acc"), seg(entry.label.toLowerCase())]
          : [
              seg(
                `${entry.key.padEnd(7)}${entry.label.toLowerCase()}  ${dot} ${entry.off}`,
                "faint",
              ),
            ],
      );
    }
  }
  if (keys.typed.length > 0) {
    if (left.length > 0) left.push([]);
    left.push([seg("NO KEY · TYPE IT", "dim")]);
    for (const line of keys.typed) left.push([seg(`$ ${line}`, "dim")]);
  }
  if (keys.move.length > 0) {
    right.push([seg("MOVE", "dim")]);
    for (const entry of keys.move) right.push([seg(entry.key.padEnd(7), "acc"), seg(entry.label)]);
  }
  if (keys.global.length > 0) {
    if (right.length > 0) right.push([]);
    right.push([seg("ANYWHERE", "dim")]);
    for (const entry of keys.global)
      right.push([seg(entry.key.padEnd(7), "acc"), seg(entry.label)]);
  }
  const title: Seg[] = [seg(helpTitle(focus, display), "hi")];
  const hint = query === "" ? "type to search" : `${query}${g.cursor}`;
  const head = [
    ...title,
    seg(" ".repeat(Math.max(1, HELP_INNER - segWidth(title) - [...hint].length))),
    seg(hint, query === "" ? "dim" : "acc"),
  ];
  const lines: Seg[][] = [head, rule(HELP_INNER)];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? [];
    const pad = Math.max(0, LEFT - segWidth(l));
    lines.push([...l, seg(" ".repeat(pad)), ...(right[i] ?? [])]);
  }
  if (rows === 0) lines.push([seg("No key matches.", "dim")]);
  lines.push(rule(HELP_INNER));
  lines.push([
    seg("Lowercase acts on this item. Capitals spend or destroy.   ", "dim"),
    seg("esc", "acc"),
    seg(" close", "dim"),
  ]);
  return lines;
}

/** The keys overlay over the body. */
export function Help(props: {
  readonly display: Display;
  readonly columns: number;
  readonly focus: PaletteFocus;
  readonly offline: boolean;
  readonly query: string;
}) {
  return (
    <Overlay
      display={props.display}
      columns={props.columns}
      inner={Math.min(HELP_INNER, props.columns - 6)}
      lines={helpLines(props.focus, props.offline, props.query, props.display)}
    />
  );
}
