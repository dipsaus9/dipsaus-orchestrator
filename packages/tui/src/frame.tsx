// The Frame (0009, DIPO-457): the one component that draws a home view's bands, the header, the
// rooms, the body, the ticker and the keys. Below 60 columns or 16 rows it draws only the widen
// message instead.

import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";

import { Colored } from "./colour";
import type { Display } from "./options";

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;

/** What the Frame says instead of the layout on a terminal that is too small. */
export const WIDEN_MESSAGE = `Widen the terminal to at least ${MIN_COLUMNS} columns`;

/** True when a terminal of this size cannot show the layout. */
export function tooSmall(columns: number, rows: number): boolean {
  return columns < MIN_COLUMNS || rows < MIN_ROWS;
}

export interface FrameProps {
  readonly display: Display;
  /** The header and the banners under it. */
  readonly header: ReactNode;
  /** The rooms band; none until the rooms exist. */
  readonly rooms?: ReactNode;
  /** The ticker: the message of the moment; none when there is nothing to say. */
  readonly ticker: string | null;
  /** The footer keys, fitted to the width by the caller. */
  readonly keys: string;
  /** The body: the mode that shows. */
  readonly children: ReactNode;
}

export function Frame(props: FrameProps) {
  const { columns, rows } = useWindowSize();
  if (tooSmall(columns, rows)) return <Text wrap="truncate-end">{WIDEN_MESSAGE}</Text>;
  return (
    <Box flexDirection="column">
      {props.header}
      {props.rooms ?? null}
      {props.children}
      {props.ticker === null ? null : (
        <Colored display={props.display} role="acc">
          {` ${props.ticker}`}
        </Colored>
      )}
      <Text wrap="truncate-end">{` ${props.keys}`}</Text>
    </Box>
  );
}
