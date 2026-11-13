// The planning view's conversation as rows (0009, DIPO-486), pure. The answers are stored worker
// output: tool calls and thinking blocks fold to one line each through the Run stream's rows
// (DIPO-461, `stream.ts`) and open on demand; the rest is the agent's markdown (`markdown.ts`).
// The proposal and question blocks the engine reads (0022) never show as text: the proposals and
// the question view are their rendered form.

import {
  PLANNING_PROPOSAL_FENCE,
  PLANNING_QUESTIONS_FENCE,
  type PlanningView,
} from "@dipsaus-orchestrator/contract";

import { markdownRows, wrapSpans } from "./markdown";
import { splitLines } from "./output";
import type { Span } from "./spans";
import { isFoldLine, streamEntries, streamRows } from "./stream";
import { clockTime } from "./views";

const BLOCK_FENCES = [PLANNING_PROPOSAL_FENCE, PLANNING_QUESTIONS_FENCE];
const OPEN = new RegExp(`^\\s*\`\`\`(?:${BLOCK_FENCES.join("|")})\\s*$`);
const CLOSE = /^\s*```\s*$/;

/**
 * One part of the conversation (DIPO-490): the model's stored output, a message the maintainer
 * sent (from the engine's record) or a dim note the view adds, such as a handover. A part's kind,
 * not its text, says who wrote it: a model line that starts with `you>` is the model's text.
 */
export type TranscriptPart =
  | { readonly kind: "model"; readonly text: string }
  | { readonly kind: "you"; readonly text: string }
  | { readonly kind: "note"; readonly text: string };

/** A transcript as parts; plain text is the model's. */
export type Transcript = string | readonly TranscriptPart[];

/**
 * Pure: the planning session's whole conversation as parts (DIPO-490): each model session's stored
 * output in order (`outputs`, by run), each of the maintainer's messages from the record at its
 * run and output offset, and one dim line where a fresh model session took over, with the reason
 * the one before ended.
 */
export function conversationParts(
  view: PlanningView,
  outputs: Readonly<Record<string, string>>,
): TranscriptPart[] {
  const runs = view.sessions ?? [{ run: view.run, startedAt: view.startedAt }];
  const parts: TranscriptPart[] = [];
  runs.forEach((model, i) => {
    const before = runs[i - 1];
    if (before !== undefined) {
      const why = before.ended === undefined ? "" : ` (${before.ended})`;
      parts.push({
        kind: "note",
        text: `continued in a fresh model session at ${clockTime(Date.parse(model.startedAt))}${why}`,
      });
    }
    const bytes = new TextEncoder().encode(outputs[model.run] ?? "");
    const decoder = new TextDecoder();
    let at = 0;
    const messages = (view.messages ?? [])
      .filter((message) => message.run === model.run)
      .toSorted((a, b) => a.outputOffset - b.outputOffset);
    for (const message of messages) {
      const to = Math.min(Math.max(at, message.outputOffset), bytes.length);
      if (to > at) parts.push({ kind: "model", text: decoder.decode(bytes.subarray(at, to)) });
      at = to;
      parts.push({ kind: "you", text: message.text });
    }
    if (bytes.length > at) parts.push({ kind: "model", text: decoder.decode(bytes.subarray(at)) });
  });
  return parts;
}

const partsOf = (transcript: Transcript): readonly TranscriptPart[] =>
  typeof transcript === "string" ? [{ kind: "model", text: transcript }] : transcript;

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
export function foldCount(transcript: Transcript): number {
  let count = 0;
  for (const part of partsOf(transcript)) {
    if (part.kind !== "model") continue;
    for (const group of groups(visibleLines(part.text))) {
      if (group.fold) count += streamEntries(group.lines).length;
    }
  }
  return count;
}

/**
 * The rows of a message the maintainer sent, as its own block (DIPO-491): a blank row before and
 * after, and each line behind a `>` prefix on the shade background. The blank rows and the prefix
 * mark it under NO_COLOR too.
 */
function youRows(text: string, width: number): Span[][] {
  const lines = splitLines(text)
    .flatMap((line) =>
      wrapSpans([{ text: line }], width, { prefix: [{ text: "> ", role: "acc" }] }),
    )
    .map((spans) => spans.map((span) => ({ ...span, shade: true })));
  return [[], ...lines, []];
}

/** The conversation `transcript` as rows `width` cells wide, with its folds numbered from 0. */
export function transcriptRows(
  transcript: Transcript,
  width: number,
  options: TranscriptOptions,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let fold = 0;
  for (const part of partsOf(transcript)) {
    if (part.kind === "you") {
      rows.push(...youRows(part.text, width).map((spans) => ({ spans })));
      continue;
    }
    if (part.kind === "note") {
      rows.push(
        ...wrapSpans([{ text: part.text, role: "dim" }], width).map((spans) => ({ spans })),
      );
      continue;
    }
    const answer: TranscriptRow[] = [];
    fold = modelRows(part.text, Math.max(10, width - 2), options, answer, fold);
    rows.push(...underMarker(answer, options));
  }
  return rows;
}

/**
 * An answer's rows under its marker (DIPO-491): `●` starts the first line, and the rest, the fold
 * lines included, sit indented under it. An answer that opens with a fold gets the marker on a row
 * of its own. The focus bar of a fold takes the place of its indent.
 */
function underMarker(
  answer: readonly TranscriptRow[],
  options: TranscriptOptions,
): TranscriptRow[] {
  const [first] = answer;
  if (first === undefined) return [];
  const marker: Span = { text: `${options.bullet} `, role: "acc" };
  const rows: TranscriptRow[] = [];
  if (first.fold !== undefined) rows.push({ spans: [{ text: options.bullet, role: "acc" }] });
  answer.forEach((row, i) => {
    const [head] = row.spans;
    const bar = head?.text.startsWith(`${options.bar} `) === true && head.role === "acc";
    const lead: Span[] =
      i === 0 && first.fold === undefined
        ? [marker]
        : bar || head === undefined
          ? []
          : [{ text: "  " }];
    rows.push({ ...row, spans: [...lead, ...row.spans] });
  });
  return rows;
}

/** Adds the rows of the model's `text` to `rows`; returns the number of the next fold. */
function modelRows(
  text: string,
  width: number,
  options: TranscriptOptions,
  rows: TranscriptRow[],
  start: number,
): number {
  let fold = start;
  for (const group of groups(visibleLines(text))) {
    if (!group.fold) {
      const block = markdownRows(group.lines, width, options);
      // A blank row between two blocks stays; one at an edge goes.
      while (block.at(-1)?.length === 0) block.pop();
      while (block[0]?.length === 0) block.shift();
      rows.push(...block.map((spans) => ({ spans })));
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
            ? [{ text: `${options.bar} `, role: "acc" as const }, first, ...rest]
            : spans;
        rows.push({ spans: marked, fold });
      });
      fold++;
    }
  }
  return fold;
}
