// The agent's markdown as rows of spans (0009, DIPO-486), pure: headings, lists, bold, inline code and
// fenced code blocks, painted only in the colour roles of `docs/design/tui-v2/roles.json`: a heading
// is hi and bold, bold text is hi and bold, inline code is acc, a code block is dim, a list marker is
// acc. Every row is wrapped at the column width at word boundaries; a word longer than the row is
// the one thing cut. `wrapSpans` is the one wrap of styled text, also the question view's.

import type { Span } from "./spans";
import { wrapWords } from "./stream";

/** The cells `spans` take. */
const cells = (spans: readonly Span[]): number => spans.reduce((n, s) => n + s.text.length, 0);

/** A word is the styled pieces between two spaces; `\s+` ends it. */
function words(spans: readonly Span[]): Span[][] {
  const found: Span[][] = [];
  let word: Span[] = [];
  const end = () => {
    if (word.length > 0) found.push(word);
    word = [];
  };
  for (const span of spans) {
    const parts = span.text.split(/(\s+)/);
    for (const part of parts) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) end();
      else word.push({ ...span, text: part });
    }
  }
  end();
  return found;
}

/** A word cut into pieces of at most `size` cells, each keeping its style. */
function cutWord(word: readonly Span[], size: number): Span[][] {
  const pieces: Span[][] = [];
  let line: Span[] = [];
  let left = size;
  for (const span of word) {
    let text = span.text;
    while (text.length > 0) {
      if (left === 0) {
        pieces.push(line);
        line = [];
        left = size;
      }
      line.push({ ...span, text: text.slice(0, left) });
      const took = Math.min(left, text.length);
      text = text.slice(took);
      left -= took;
    }
  }
  if (line.length > 0) pieces.push(line);
  return pieces;
}

/**
 * `spans` as rows of at most `width` cells, broken at spaces. The first row starts with `prefix`,
 * later rows with `indent` spaces; both count in the width.
 */
export function wrapSpans(
  spans: readonly Span[],
  width: number,
  options: { readonly prefix?: readonly Span[]; readonly indent?: number } = {},
): Span[][] {
  const prefix = options.prefix ?? [];
  const indent = Math.min(options.indent ?? cells(prefix), Math.max(0, width - 1));
  const lead = (first: boolean): Span[] => (first ? [...prefix] : [{ text: " ".repeat(indent) }]);
  const rows: Span[][] = [];
  let row = lead(true);
  let used = cells(row);
  let empty = true;
  const next = () => {
    rows.push(row);
    row = lead(false);
    used = indent;
    empty = true;
  };
  for (const word of words(spans)) {
    const size = cells(word);
    if (!empty && used + 1 + size > width) next();
    if (empty && used + size > width) {
      const pieces = cutWord(word, Math.max(1, width - used));
      pieces.forEach((piece, i) => {
        row.push(...piece);
        if (i < pieces.length - 1) next();
        else {
          used += cells(piece);
          empty = false;
        }
      });
      continue;
    }
    if (!empty) {
      row.push({ text: " " });
      used += 1;
    }
    row.push(...word);
    used += size;
    empty = false;
  }
  rows.push(row);
  return rows;
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

/** One line of text as spans: `**bold**` is hi and bold, `code` is acc; the marks go. */
export function inlineSpans(text: string): Span[] {
  return text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part): Span => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return { text: part.slice(2, -2), role: "hi", bold: true };
      }
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return { text: part.slice(1, -1), role: "acc" };
      }
      return { text: part };
    });
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;

/** The rows of `lines` read as markdown, `width` cells wide. */
export function markdownRows(
  lines: readonly string[],
  width: number,
  options: { readonly bullet: string },
): Span[][] {
  const rows: Span[][] = [];
  let code = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      code = !code;
      continue;
    }
    if (code) {
      for (const text of wrapWords(`  ${line.trimEnd()}`, width)) {
        rows.push([{ text, role: "dim" }]);
      }
      continue;
    }
    if (line.trim() === "") {
      if (rows.length > 0 && rows.at(-1)?.length !== 0) rows.push([]);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      rows.push(
        ...wrapSpans([{ text: heading[1] ?? "", role: "hi", bold: true }], width, { indent: 0 }),
      );
      continue;
    }
    const item = LIST.exec(line);
    if (item !== null) {
      const depth = Math.min(6, Math.floor((item[1] ?? "").length / 2)) * 2;
      const marker = /^\d/.test(item[2] ?? "") ? (item[2] ?? "") : options.bullet;
      const prefix: Span[] = [
        ...(depth > 0 ? [{ text: " ".repeat(depth) }] : []),
        { text: `${marker} `, role: "acc" },
      ];
      rows.push(...wrapSpans(inlineSpans(item[3] ?? ""), width, { prefix }));
      continue;
    }
    rows.push(...wrapSpans(inlineSpans(line.trim()), width, { indent: 0 }));
  }
  while (rows.at(-1)?.length === 0) rows.pop();
  return rows;
}
