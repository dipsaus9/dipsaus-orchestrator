// Lines of coloured spans (0009, DIPO-460): a screen line that mixes roles, like the Floor's
// pipeline line or its budget bar. Every span goes through `Colored`; the line is memoised by what
// it says, so a line renders again only when its text or a role changes.

import { Text } from "ink";
import { Fragment, memo } from "react";

import { Colored, type Role } from "./colour";
import type { Display } from "./options";

export interface Span {
  readonly text: string;
  readonly role?: Role | undefined;
  /** Painted on the focused row's background (the `sel` role). */
  readonly sel?: boolean;
  readonly bold?: boolean;
  readonly underline?: boolean;
}

/** `spans` on the focused row's background when `on`: the background covers every cell it wraps. */
export function focused(spans: readonly Span[], on: boolean): readonly Span[] {
  return on ? spans.map((span) => ({ ...span, sel: true })) : spans;
}

/** The plain text of a line of spans. */
export function spansText(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join("");
}

/** What a line looks like, for memoising: each span's role, style and text. */
function signature(spans: readonly Span[]): string {
  return spans
    .map(
      (s) =>
        `${s.role ?? ""}${s.sel === true ? "s" : ""}${s.bold === true ? "b" : ""}${s.underline === true ? "u" : ""}:${s.text}`,
    )
    .join("\u0000");
}

/** `spans` cut to `width` cells, the last span cut short; never longer. */
export function cutSpans(spans: readonly Span[], width: number): Span[] {
  const out: Span[] = [];
  let left = Math.max(0, width);
  for (const span of spans) {
    if (left <= 0) break;
    out.push(span.text.length <= left ? span : { ...span, text: span.text.slice(0, left) });
    left -= span.text.length;
  }
  return out;
}

/** `left` and `right` on one line of `width` cells: the gap between them is spaces. */
export function spread(left: readonly Span[], right: readonly Span[], width: number): Span[] {
  const gap = width - spansText(left).length - spansText(right).length;
  if (gap < 1) return cutSpans([...left, { text: " " }, ...right], width);
  return [...left, { text: " ".repeat(gap) }, ...right];
}

export const SpanLine = memo(
  function SpanLine(props: { spans: readonly Span[]; display: Display }) {
    // An empty line still takes its row: Ink gives an empty Text no height.
    const spans = props.spans.length === 0 ? [{ text: " " }] : props.spans;
    const { display } = props;
    return (
      <Text wrap="truncate-end">
        {spans.map((span, i) => {
          const text = (
            <Colored
              display={display}
              role={span.role}
              {...(span.bold === true ? { bold: true } : {})}
              {...(span.underline === true ? { underline: true } : {})}
            >
              {span.text}
            </Colored>
          );
          return span.sel === true ? (
            <Colored key={i} display={display} role="sel">
              {text}
            </Colored>
          ) : (
            <Fragment key={i}>{text}</Fragment>
          );
        })}
      </Text>
    );
  },
  (prev, next) => prev.display === next.display && signature(prev.spans) === signature(next.spans),
);
