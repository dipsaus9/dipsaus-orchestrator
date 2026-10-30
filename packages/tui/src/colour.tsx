// The one place the TUI styles text (0009, DIPO-320): every colour and every bold run goes through
// `Colored`, which drops them when the display has no colour (`NO_COLOR` or `--no-color`), so a
// monochrome terminal gets the same words and glyphs. `colour.test.ts` keeps every other file
// free of Ink's colour props.

import { Text, type TextProps } from "ink";
import type { ReactNode } from "react";

import type { Display } from "./options";

export interface ColoredProps {
  readonly display: Display;
  /** No colour when undefined: the text is plain, also on a colour display. */
  readonly color?: string | undefined;
  readonly bold?: boolean;
  readonly wrap?: TextProps["wrap"];
  readonly children: ReactNode;
}

/** `children` in `color` and bold when the display has colour, plain otherwise. */
export function Colored(props: ColoredProps) {
  const { display, color, bold, wrap, children } = props;
  const style: TextProps = display.color
    ? { ...(color === undefined ? {} : { color }), ...(bold === true ? { bold } : {}) }
    : {};
  return (
    <Text {...style} {...(wrap === undefined ? {} : { wrap })}>
      {children}
    </Text>
  );
}
