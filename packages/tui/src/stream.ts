// The run stream as a table (0009, DIPO-461): the stored worker output read as rows of time, verb
// and target. A tool line is `read  engine/src/a.ts`, consecutive thinking blocks fold into one
// line with their count and tokens, the agent's own words (`says`) and a verdict are bright, and the
// engine's phase markers open sections. The sources are filter tabs: all, worker, reviewer (the
// review phase's lines of the worker output), verify and prompt. Stored lines carry no time of
// their own, so a line shows the time of the phase marker that opened its section.
// A message the maintainer steered with shows as a `you` line with its delivery state.

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

import { type OutputLine, isGap, isMarker, displayLine } from "./output";
import type { Span } from "./spans";
import { clockTime } from "./views";

export const STREAM_FILTERS = ["all", "worker", "reviewer", "verify", "prompt"] as const;
export type StreamFilter = (typeof STREAM_FILTERS)[number];

/** The filter after `filter`, for `v`. */
export function nextFilter(filter: StreamFilter): StreamFilter {
  return STREAM_FILTERS[(STREAM_FILTERS.indexOf(filter) + 1) % STREAM_FILTERS.length] ?? "all";
}

/** The phase whose worker output is the reviewer's. */
const REVIEW_PHASE = "review";

/** One stream entry, before it is cut into rows. */
export type StreamEntry =
  | { readonly kind: "head"; readonly text: string; readonly reviewer: boolean }
  | {
      readonly kind: "tool";
      readonly time: string;
      readonly verb: string;
      readonly target: string;
      readonly reviewer: boolean;
    }
  | {
      readonly kind: "thinking";
      readonly time: string;
      readonly count: number;
      readonly seconds: number | null;
      readonly tokens: number | null;
      readonly reviewer: boolean;
    }
  | {
      readonly kind: "says" | "verdict";
      readonly time: string;
      readonly text: string;
      readonly reviewer: boolean;
    }
  | { readonly kind: "gap"; readonly text: string; readonly reviewer: boolean }
  | { readonly kind: "plain"; readonly text: string; readonly reviewer: boolean };

const TOOL = /^\[tool\] (\S+)(?: (.*))?$/;
const THINKING = /^\[thinking\](?: (\d+(?:\.\d+)?)s)?(?: ~(\d+) tokens)?$/;
const VERDICT = /^verdict\b[:\s-]*(.*)$/i;

/** `1000` tokens as `1.0k`; under a hundred as the number. */
export function tokensText(tokens: number): string {
  return tokens >= 100 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** The text of a folded thinking entry: `4 thoughts · 1.0k tokens` or `thinking 1.1s`. */
export function thinkingText(
  entry: Extract<StreamEntry, { kind: "thinking" }>,
  dot: string,
): string {
  const tokens = entry.tokens === null ? [] : [`${tokensText(entry.tokens)} tokens`];
  if (entry.count > 1) return [`${entry.count} thoughts`, ...tokens].join(` ${dot} `);
  const first = `thinking${entry.seconds === null ? "" : ` ${entry.seconds.toFixed(1)}s`}`;
  return [first, ...tokens].join(` ${dot} `);
}

/** The label of a phase marker's section: `review · reviewer · 10:39`. */
function sectionLabel(marker: OutputMarker, dot: string): string {
  const time = clockTime(Date.parse(marker.at));
  if (marker.kind === "phase") {
    const who = marker.value === REVIEW_PHASE ? ` ${dot} reviewer` : "";
    return `${marker.value}${who} ${dot} ${time}`;
  }
  return `${marker.kind === "ended" ? "run ended" : marker.kind} ${dot} ${marker.value} ${dot} ${time}`;
}

type Thinking = Extract<StreamEntry, { kind: "thinking" }>;

/** One stored thinking line added to the entries: it folds into a thinking entry just above. */
function addThinking(
  entries: StreamEntry[],
  thought: RegExpExecArray,
  time: string,
  reviewer: boolean,
): void {
  const seconds = thought[1] === undefined ? null : Number(thought[1]);
  const tokens = thought[2] === undefined ? null : Number(thought[2]);
  const last = entries.at(-1);
  if (last?.kind !== "thinking") {
    entries.push({ kind: "thinking", time, count: 1, seconds, tokens, reviewer });
    return;
  }
  const folded: Thinking = {
    ...last,
    count: last.count + 1,
    seconds: seconds === null ? last.seconds : (last.seconds ?? 0) + seconds,
    tokens: tokens === null ? last.tokens : (last.tokens ?? 0) + tokens,
  };
  entries[entries.length - 1] = folded;
}

/** A tool call, a verdict or the agent's words, from one stored text line. */
function textEntry(text: string, time: string, reviewer: boolean): StreamEntry {
  const tool = TOOL.exec(text);
  if (tool !== null) {
    return {
      kind: "tool",
      time,
      verb: (tool[1] ?? "").toLowerCase(),
      target: tool[2] ?? "",
      reviewer,
    };
  }
  const verdict = VERDICT.exec(text);
  if (verdict !== null) return { kind: "verdict", time, text: verdict[1] ?? "", reviewer };
  return { kind: "says", time, text, reviewer };
}

/**
 * The entries of held output `lines`: markers open sections, consecutive thinking blocks of one
 * section fold into one entry, and empty lines drop out. Verify's text stays plain lines.
 */
export function streamEntries(
  lines: readonly OutputLine[],
  dot = "·",
  source: "worker" | "verify" = "worker",
): StreamEntry[] {
  const entries: StreamEntry[] = [];
  let time = "";
  let reviewer = false;
  for (const line of lines) {
    if (isMarker(line)) {
      time = clockTime(Date.parse(line.at));
      reviewer = line.kind === "phase" && line.value === REVIEW_PHASE;
      entries.push({ kind: "head", text: sectionLabel(line, dot), reviewer });
    } else if (isGap(line)) {
      entries.push({ kind: "gap", text: displayLine(line), reviewer });
    } else if (line.trim() !== "") {
      const text = line.trim();
      const thought = THINKING.exec(text);
      // Verify prints plain text: no verbs, no thinking.
      if (source === "verify") entries.push({ kind: "plain", text: line.trimEnd(), reviewer });
      else if (thought === null) entries.push(textEntry(text, time, reviewer));
      else addThinking(entries, thought, time, reviewer);
    }
  }
  return entries;
}

/** What each filter shows of the worker's and verify's entries; `all` is the worker's, then verify's. */
export function filterEntries(
  filter: StreamFilter,
  worker: readonly StreamEntry[],
  verify: readonly StreamEntry[],
): StreamEntry[] {
  if (filter === "worker") return worker.filter((entry) => !entry.reviewer);
  if (filter === "reviewer") return worker.filter((entry) => entry.reviewer);
  if (filter === "verify") return [...verify];
  const verifyHead: StreamEntry[] =
    verify.length === 0 ? [] : [{ kind: "head", text: "verify", reviewer: false }];
  return [...worker, ...verifyHead, ...verify];
}

/** Columns taken before the target: two of lead, the time, two, the verb and one. */
export const GUTTER = 16;
const VERB_WIDTH = 7;
/** Said after a tool target cut short: Enter shows it whole. */
const FULL_HINT = " ⏎ full";

/** A message sent to the run while the maintainer watched, with what became of it. */
export interface SentSteer {
  readonly id: number;
  readonly at: number;
  readonly text: string;
  readonly state:
    | { readonly kind: "sending" }
    | { readonly kind: "delivered"; readonly when: "next-turn" | "on-resume" }
    | { readonly kind: "failed"; readonly message: string };
}

/** Where a delivered steer arrives, in the words of its `you` line. */
export function deliveryText(state: SentSteer["state"], dot: string): string {
  if (state.kind === "sending") return `${dot} sending`;
  if (state.kind === "failed") return `${dot} not sent: ${state.message}`;
  return `${dot} delivered ${state.when === "next-turn" ? "next turn" : "on resume"}`;
}

/** One stream row of spans. */
export type StreamRow = readonly Span[];

/** The verb cell: seven columns, and a verb that fills them still gets its space. */
function verbCell(verb: string): string {
  return verb.length >= VERB_WIDTH ? `${verb} ` : verb.padEnd(VERB_WIDTH);
}

function lead(time: string, verb: string, role: Span["role"]): Span[] {
  return [
    { text: `  ${time.padEnd(5)}  `, role: "dim" },
    { text: verbCell(verb), role },
  ];
}

function gutter(): Span {
  return { text: " ".repeat(GUTTER) };
}

/** `text` cut into rows of `width` cells at spaces where it can. */
export function wrapWords(text: string, width: number): string[] {
  const size = Math.max(1, width);
  const rows: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const space = rest.lastIndexOf(" ", size);
    const at = space > 0 ? space : size;
    rows.push(rest.slice(0, at));
    rest = rest.slice(space > 0 ? at + 1 : at);
  }
  rows.push(rest);
  return rows;
}

/**
 * The entries as rows for a stream `width` columns wide. A tool target is one row cut with an
 * ellipsis and `⏎ full`, or with `full` in as many rows as it takes. The time and verb of an entry
 * of the same kind as the one above stay blank for `says`, so a run of words reads as one block.
 */
export function streamRows(
  entries: readonly StreamEntry[],
  width: number,
  options: {
    readonly full: boolean;
    readonly dot: string;
    readonly ellipsis: string;
    readonly rule: string;
  },
): StreamRow[] {
  const rows: StreamRow[] = [];
  const room = Math.max(10, width - GUTTER);
  let previous: StreamEntry["kind"] | null = null;
  for (const entry of entries) {
    if (entry.kind === "head") {
      const label = `${options.rule}${options.rule} ${entry.text} `;
      const fill = options.rule.repeat(Math.max(2, width - 2 - label.length));
      rows.push([{ text: `  ${label}${fill}`, role: "dim" }]);
    } else if (entry.kind === "gap") {
      rows.push([{ text: `  ${entry.text}`, role: "dim" }]);
    } else if (entry.kind === "plain") {
      rows.push([gutter(), { text: entry.text }]);
    } else if (entry.kind === "thinking") {
      const first = lead(entry.time, options.dot.repeat(2), "dim");
      wrapWords(thinkingText(entry, options.dot), room).forEach((text, i) => {
        rows.push([...(i === 0 ? first : [gutter()]), { text, role: "dim" }]);
      });
    } else if (entry.kind === "tool") {
      const cut = !options.full && entry.target.length > room;
      const kept = room - FULL_HINT.length - options.ellipsis.length;
      const body = options.full
        ? wrapWords(entry.target, room)
        : [cut ? `${entry.target.slice(0, kept)}${options.ellipsis}` : entry.target];
      const first = lead(entry.time, entry.verb, undefined);
      body.forEach((text, i) => {
        rows.push([
          ...(i === 0 ? first : [gutter()]),
          { text },
          ...(cut && i === 0 ? [{ text: FULL_HINT, role: "dim" as const }] : []),
        ]);
      });
    } else {
      // The agent's words and a verdict are bright; a run of words reads as one block.
      const again = entry.kind === "says" && previous === "says";
      const first = again
        ? [gutter()]
        : lead(entry.time, entry.kind, entry.kind === "verdict" ? "ok" : "acc");
      wrapWords(entry.text, entry.kind === "verdict" ? room - 1 : room).forEach((text, i) => {
        rows.push([...(i === 0 ? first : [gutter()]), { text, role: "hi" }]);
      });
    }
    previous = entry.kind;
  }
  return rows;
}

/** The `you` line of a sent steer: `10:42  you    Don’t raise the timeout… · delivered next turn`. */
export function youRow(
  sent: SentSteer,
  width: number,
  options: { readonly dot: string; readonly ellipsis: string },
): StreamRow {
  const oneLine = sent.text.replace(/\s+/g, " ").trim();
  const state = deliveryText(sent.state, options.dot);
  const room = Math.max(8, width - GUTTER - state.length - 1);
  const text =
    oneLine.length <= room
      ? oneLine
      : `${oneLine.slice(0, room - options.ellipsis.length)}${options.ellipsis}`;
  return [
    { text: `  ${clockTime(sent.at).padEnd(5)}  `, role: "dim" },
    { text: verbCell("you"), role: sent.state.kind === "failed" ? "err" : "ok" },
    { text: `${text} ` },
    { text: state, role: sent.state.kind === "failed" ? "err" : "dim" },
  ];
}

/** What the engine's reply to `work.steer` says became of the message. */
export function steerState(
  outcome:
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): SentSteer["state"] {
  if (!outcome.ok)
    return { kind: "failed", message: `${outcome.error.code}: ${outcome.error.message}` };
  const delivered = (outcome.result as { delivered?: unknown } | null)?.delivered;
  if (delivered === "next-turn" || delivered === "on-resume") {
    return { kind: "delivered", when: delivered };
  }
  return { kind: "failed", message: "the reply did not say when it arrives" };
}
