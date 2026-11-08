// The Frame (0009, DIPO-457, DIPO-458): the one component that draws a screen's bands, the header,
// the rooms, a rule, the body, the ticker, a rule and the keys. Below 60 columns or 16 rows it
// draws only the widen message instead. `z` on the run stream draws the body alone (`bare`).

import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";

import { Colored } from "./colour";
import { footerLine, HINT_GAP, type Hint } from "./footer";
import type { Display } from "./options";

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;

/** What the Frame says instead of the layout on a terminal that is too small. */
export const WIDEN_MESSAGE = `Widen the terminal to at least ${MIN_COLUMNS} columns`;

/** True when a terminal of this size cannot show the layout. */
export function tooSmall(columns: number, rows: number): boolean {
  return columns < MIN_COLUMNS || rows < MIN_ROWS;
}

/** The rows the Frame takes around the body: header, the two rules and the keys, rooms and ticker. */
export function frameRows(rooms: boolean, ticker: boolean): number {
  return 4 + (rooms ? 1 : 0) + (ticker ? 1 : 0);
}

export interface FrameProps {
  readonly display: Display;
  /** The header and the banners under it. */
  readonly header: ReactNode;
  /** The rooms band; none outside an office's rooms. */
  readonly rooms?: ReactNode;
  /** The ticker: the latest event or message, dim; none when there is nothing to say. */
  readonly ticker: string | null;
  /** The footer keys, fitted to the width by the caller. */
  readonly keys: readonly Hint[];
  /** Only the body, for the expanded run stream. */
  readonly bare?: boolean;
  /** The body: the mode that shows. */
  readonly children: ReactNode;
}

/** A full-width pane rule in faint; `-` under `--ascii`. */
export function Rule(props: { readonly display: Display; readonly columns: number }) {
  return (
    <Colored display={props.display} role="faint" wrap="truncate-end">
      {(props.display.ascii ? "-" : "─").repeat(Math.max(0, props.columns))}
    </Colored>
  );
}

/** One hint: the key in acc, the label in fg, or dim on the right; a warning in err. */
function HintText(props: { readonly display: Display; readonly hint: Hint }) {
  const { display, hint } = props;
  if (hint.warning === true) {
    return (
      <Colored display={display} role="err">
        {hint.label}
      </Colored>
    );
  }
  const right = hint.side === "right";
  return (
    <>
      {hint.key === "" ? null : (
        <Colored display={display} role="acc">
          {hint.key}
        </Colored>
      )}
      <Colored display={display} role={right ? "dim" : undefined}>
        {hint.key === "" ? hint.label : ` ${hint.label}`}
      </Colored>
    </>
  );
}

/** The footer: verbs left, global keys at the right end (`footerLine` is the same as text). */
export function FooterLine(props: {
  readonly display: Display;
  readonly hints: readonly Hint[];
  readonly columns: number;
}) {
  const { display, hints, columns } = props;
  const text = footerLine(hints, columns);
  const left = hints.filter((hint) => (hint.side ?? "left") === "left");
  const right = hints.filter((hint) => hint.side === "right");
  const leftWidth = footerLine(left, columns).length;
  const pad = Math.max(0, text.length - leftWidth - footerLine(right, 0).length);
  const join = (list: readonly Hint[], side: string) =>
    list.map((hint, i) => (
      <Text key={`${side}${i}`}>
        {i === 0 ? "" : HINT_GAP}
        <HintText display={display} hint={hint} />
      </Text>
    ));
  return (
    <Text wrap="truncate-end">
      {join(left, "l")}
      {" ".repeat(pad)}
      {join(right, "r")}
    </Text>
  );
}

export function Frame(props: FrameProps) {
  const { columns, rows } = useWindowSize();
  if (tooSmall(columns, rows)) return <Text wrap="truncate-end">{WIDEN_MESSAGE}</Text>;
  if (props.bare === true) return <Box flexDirection="column">{props.children}</Box>;
  const width = columns - 1;
  return (
    <Box flexDirection="column">
      {props.header}
      {props.rooms ?? null}
      <Rule display={props.display} columns={width} />
      {props.children}
      {props.ticker === null ? null : (
        <Colored display={props.display} role="dim" wrap="truncate-end">
          {props.ticker}
        </Colored>
      )}
      <Rule display={props.display} columns={width} />
      <FooterLine display={props.display} hints={props.keys} columns={width} />
    </Box>
  );
}
