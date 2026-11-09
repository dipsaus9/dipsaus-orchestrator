// Lines made of painted pieces (spec.md, Reading the screen files): each piece is text in a colour
// role, bold or underlined as a mock marks it. The Desk's list, preview and prompts build their
// rows as such lines, so their width is known before Ink draws them and a test can read them.

import { Text } from "ink";

import { Colored, type Role } from "./colour";
import type { Display } from "./options";

/** One painted piece of a line. */
export interface Seg {
  readonly text: string;
  readonly role?: Role;
  readonly bold?: boolean;
  readonly underline?: boolean;
  /** On the focused row's background (`[sel]…[/]`). */
  readonly sel?: boolean;
}

export type SegLine = readonly Seg[];

/** A piece in `role`. */
export function seg(text: string, role?: Role, bold?: boolean): Seg {
  return { text, ...(role === undefined ? {} : { role }), ...(bold === true ? { bold } : {}) };
}

/** The cells a line takes. */
export function lineWidth(line: SegLine): number {
  return line.reduce((sum, piece) => sum + piece.text.length, 0);
}

/** The line's text without its paint. */
export function lineText(line: SegLine): string {
  return line.map((piece) => piece.text).join("");
}

/** The line cut to `width` cells, then padded with spaces to exactly `width`. */
export function fitLine(line: SegLine, width: number): SegLine {
  const out: Seg[] = [];
  let left = Math.max(0, width);
  for (const piece of line) {
    if (left === 0) break;
    const text = piece.text.slice(0, left);
    out.push({ ...piece, text });
    left -= text.length;
  }
  if (left > 0) out.push({ text: " ".repeat(left) });
  return out;
}

/** `left` and `right` on one line of `width` cells, `right` at its end. */
export function spread(left: SegLine, right: SegLine, width: number): SegLine {
  const gap = Math.max(1, width - lineWidth(left) - lineWidth(right));
  return [...left, { text: " ".repeat(gap) }, ...right];
}

/** The line's pieces on the focused row's background. */
export function selected(line: SegLine): SegLine {
  return line.map((piece) => ({ ...piece, sel: true }));
}

/** One piece, painted; a `sel` piece sits on the focused row's background. */
function Piece(props: { readonly piece: Seg; readonly display: Display }) {
  const { piece, display } = props;
  const painted = (
    <Colored
      display={display}
      {...(piece.role === undefined ? {} : { role: piece.role })}
      {...(piece.bold === true ? { bold: true } : {})}
      {...(piece.underline === true ? { underline: true } : {})}
    >
      {piece.text}
    </Colored>
  );
  return piece.sel === true ? (
    <Colored display={display} role="sel">
      {painted}
    </Colored>
  ) : (
    painted
  );
}

/** One line of pieces as one terminal row; an empty line keeps its row. */
export function SegRow(props: { readonly line: SegLine; readonly display: Display }) {
  if (lineWidth(props.line) === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {props.line.map((piece, i) => (
        <Piece key={i} piece={piece} display={props.display} />
      ))}
    </Text>
  );
}
