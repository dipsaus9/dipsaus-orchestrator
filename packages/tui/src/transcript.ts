// The planning view's conversation as rows (0009, DIPO-486), pure. The answers are stored worker
// output: tool calls and thinking blocks fold to one line each through the Run stream's rows
// (DIPO-461, `stream.ts`) and open on demand; the rest is the agent's markdown (`markdown.ts`).
// The proposal and question blocks the engine reads (0022) never show as text: the proposals and
// the question view are their rendered form.

import { PLANNING_PROPOSAL_FENCE, PLANNING_QUESTIONS_FENCE } from "@dipsaus-orchestrator/contract";

import { markdownRows, wrapSpans } from "./markdown";
import { splitLines } from "./output";
import type { Span } from "./spans";
import { isFoldLine, streamEntries, streamRows } from "./stream";

const BLOCK_FENCES = [PLANNING_PROPOSAL_FENCE, PLANNING_QUESTIONS_FENCE];
const OPEN = new RegExp(`^\\s*\`\`\`(?:${BLOCK_FENCES.join("|")})\\s*$`);
const CLOSE = /^\s*```\s*$/;
/** The maintainer's own lines, added by the view (`planning.tsx`). */
const YOU = /^you> ?/;

/** One row of the conversation; `fold` is the number of the fold it belongs to. */
export interface TranscriptRow {
  readonly spans: readonly Span[];
  readonly fold?: number;
}

export interface TranscriptOptions {
  readonly dot: string;
  readonly ellipsis: string;
  readonly rule: string;
  /** The focus bar and the list bullet, per `glyphs`. */
  readonly bar: string;
  readonly bullet: string;
  /** The folds that are open, by number. */
  readonly open: ReadonlySet<number>;
  /** The fold under the focus bar, or null. */
  readonly focus: number | null;
}

/** True when `partial`, a last line still being written, can only become a block's opening fence. */
function startsBlock(partial: string): boolean {
  const text = partial.trim();
  return text.length >= 3 && BLOCK_FENCES.some((fence) => `\`\`\`${fence}`.startsWith(text));
}

/** `text` as lines without the proposal and question blocks, closed or still open. */
export function visibleLines(text: string): string[] {
  const lines = splitLines(text);
  if (!text.endsWith("\n") && startsBlock(lines.at(-1) ?? "")) lines.pop();
  const shown: string[] = [];
  let hidden = false;
  for (const line of lines) {
    if (hidden) hidden = !CLOSE.test(line);
    else if (OPEN.test(line)) hidden = true;
    else shown.push(line);
  }
  return shown;
}

type Group = { readonly fold: boolean; readonly lines: string[] };

/** The lines in runs of folding lines and runs of text; blank lines between two folds are dropped. */
function groups(lines: readonly string[]): Group[] {
  const folds = lines.map(isFoldLine);
  // Whether the last / next non-blank line around each line is a fold.
  const after: boolean[] = [];
  let next = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    after[i] = next;
    if ((lines[i] ?? "").trim() !== "") next = folds[i] === true;
  }
  const found: Group[] = [];
  let before = false;
  lines.forEach((line, i) => {
    const fold = folds[i] === true;
    const blank = line.trim() === "";
    const between = blank && before && after[i] === true;
    if (!blank) before = fold;
    if (between) return;
    const last = found.at(-1);
    if (last?.fold === fold) last.lines.push(line);
    else found.push({ fold, lines: [line] });
  });
  return found;
}

/** How many folds the conversation has. */
export function foldCount(text: string): number {
  let count = 0;
  for (const group of groups(visibleLines(text))) {
    if (group.fold) count += streamEntries(group.lines).length;
  }
  return count;
}

/** The maintainer's lines are `you` and the text; the others are markdown. */
function textRows(lines: readonly string[], width: number, options: TranscriptOptions): Span[][] {
  const rows: Span[][] = [];
  let markdown: string[] = [];
  const flush = () => {
    rows.push(...markdownRows(markdown, width, options));
    markdown = [];
  };
  for (const line of lines) {
    if (YOU.test(line)) {
      flush();
      rows.push(
        ...wrapSpans([{ text: line.replace(YOU, "") }], width, {
          prefix: [{ text: "you> ", role: "ok" }],
        }),
      );
    } else markdown.push(line);
  }
  flush();
  return rows;
}

/** The conversation `transcript` as rows `width` cells wide, with its folds numbered from 0. */
export function transcriptRows(
  transcript: string,
  width: number,
  options: TranscriptOptions,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let fold = 0;
  for (const group of groups(visibleLines(transcript))) {
    if (!group.fold) {
      const text = textRows(group.lines, width, options);
      // A blank row between two blocks stays; one at an edge goes.
      while (text.at(-1)?.length === 0) text.pop();
      while (text[0]?.length === 0) text.shift();
      rows.push(...text.map((spans) => ({ spans })));
      continue;
    }
    for (const entry of streamEntries(group.lines, options.dot)) {
      const own = streamRows([entry], width, {
        full: options.open.has(fold),
        dot: options.dot,
        ellipsis: options.ellipsis,
        rule: options.rule,
      });
      own.forEach((spans, i) => {
        const [first, ...rest] = spans;
        const marked =
          i === 0 && options.focus === fold && first !== undefined
            ? [
                { text: `${options.bar} `, role: "acc" as const },
                { ...first, text: first.text.slice(2) },
                ...rest,
              ]
            : spans;
        rows.push({ spans: marked, fold });
      });
      fold++;
    }
  }
  return rows;
}
