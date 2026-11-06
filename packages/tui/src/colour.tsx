// The one place the TUI styles text (0009, DIPO-320, DIPO-457): every colour and every bold run goes
// through `Colored`, which takes a role of `docs/design/tui-v2/roles.json` and drops the colour
// when the display has none (`NO_COLOR` or `--no-color`), so a monochrome terminal gets the same
// words and glyphs. Bold and underline stay under NO_COLOR. `colour.test.ts` keeps every other file
// free of Ink's colour props.

import { Text, type TextProps } from "ink";
import type { ReactNode } from "react";

import type { Display } from "./options";
import type { Tone } from "./theme";

export const ROLES = [
  "bg",
  "fg",
  "hi",
  "dim",
  "faint",
  "acc",
  "ok",
  "err",
  "sel",
  "shade",
] as const;
export type Role = (typeof ROLES)[number];

/** How a role is painted on one theme. */
interface Paint {
  /** The foreground, or the background for `sel`; undefined is the terminal's default. */
  readonly color?: string;
  /** SGR 2, for the roles darker than dim. */
  readonly faint?: boolean;
}

type ByTone = Readonly<Record<Tone, Paint>>;

/** Each role on its ANSI slot, so the terminal's own theme shows through, in dark and light. */
const ANSI: Readonly<Record<Role, ByTone>> = {
  bg: { dark: {}, light: {} },
  fg: { dark: {}, light: {} },
  hi: { dark: { color: "whiteBright" }, light: { color: "black" } },
  dim: { dark: { color: "blackBright" }, light: { color: "blackBright" } },
  faint: {
    dark: { color: "blackBright", faint: true },
    light: { color: "blackBright", faint: true },
  },
  acc: { dark: { color: "yellow" }, light: { color: "yellow" } },
  ok: { dark: { color: "green" }, light: { color: "green" } },
  err: { dark: { color: "red" }, light: { color: "red" } },
  sel: { dark: { color: "ansi256(235)" }, light: { color: "ansi256(255)" } },
  shade: {
    dark: { color: "black", faint: true },
    light: { color: "white", faint: true },
  },
};

/** The opt-in truecolor Classical theme, as the HTML previews paint it. */
export const TRUECOLOR: Readonly<Record<Role, Readonly<Record<Tone, string>>>> = {
  bg: { dark: "#1c1b19", light: "#f6f4f1" },
  fg: { dark: "#ddd8cf", light: "#2d2b2b" },
  hi: { dark: "#f6f2ea", light: "#141312" },
  dim: { dark: "#8f8a82", light: "#6e6a66" },
  faint: { dark: "#3d3a35", light: "#d3cfca" },
  acc: { dark: "#e1ad66", light: "#7d5411" },
  ok: { dark: "#a3c48e", light: "#3f6b2f" },
  err: { dark: "#e58b78", light: "#a33a2b" },
  sel: { dark: "#2a2824", light: "#ebe6de" },
  shade: { dark: "#4a4740", light: "#c9c5c0" },
};

/** The ANSI slot of a role (what a terminal that follows its own theme paints). */
export function ansiPaint(role: Role, tone: Tone): Paint {
  return ANSI[role][tone];
}

/** The Ink style of `role` on `display`; empty when the display has no colour or the role is a default. */
export function roleStyle(role: Role, display: Display): TextProps {
  if (!display.color) return {};
  const tone = display.tone ?? "dark";
  if (display.classical === true) {
    // The previews paint the background only on the focus row; bg is the terminal's own.
    if (role === "sel") return { backgroundColor: TRUECOLOR.sel[tone] };
    if (role === "bg") return {};
    return { color: TRUECOLOR[role][tone] };
  }
  const paint = ANSI[role][tone];
  if (paint.color === undefined) return {};
  if (role === "sel") return { backgroundColor: paint.color };
  return { color: paint.color, ...(paint.faint === true ? { dimColor: true } : {}) };
}

export interface ColoredProps {
  readonly display: Display;
  /** No colour when undefined: the text is plain, also on a colour display. */
  readonly role?: Role | undefined;
  readonly bold?: boolean;
  readonly underline?: boolean;
  readonly wrap?: TextProps["wrap"];
  readonly children: ReactNode;
}

/** `children` in `role`, bold and underlined as asked; plain, bar bold and underline, without colour. */
export function Colored(props: ColoredProps) {
  const { display, role, bold, underline, wrap, children } = props;
  const style: TextProps = {
    ...(role === undefined ? {} : roleStyle(role, display)),
    ...(bold === true ? { bold } : {}),
    ...(underline === true ? { underline } : {}),
  };
  return (
    <Text {...style} {...(wrap === undefined ? {} : { wrap })}>
      {children}
    </Text>
  );
}
