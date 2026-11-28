// A background item at its own level (DIPO-528, 0009; screens/04-background-detail.txt): a story
// PR's required checks at the left, NEXT under them, and the focused check's log tail at the right.
// Every word is the engine's (`BackgroundItem.detail`); the TUI places it. The header carries the
// path `Floor / PR #698` and `● live`, the line under it the story and its Pipeline at the merge.

import type {
  BackgroundCheck,
  BackgroundItem,
  BackgroundLogLine,
} from "@dipsaus-orchestrator/contract";
import { Box } from "ink";

import type { Display } from "./options";
import { pipelineSpans } from "./pipeline";
import { cutSpans, focused, type Span, SpanLine, spansText, spread } from "./spans";
import { clockTime, glyphs } from "./views";

/** Columns of the checks list; the rule `│` follows. */
const LEFT = 28;

/** The story id a story PR's subject starts with (`DIPO-512 · CI failed …`). */
export function itemStory(item: BackgroundItem): string {
  return item.subject.split(/\s/)[0] ?? item.ref;
}

function time(at: string): string {
  return clockTime(Date.parse(at));
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60)}s`;
}

function checkGlyph(check: BackgroundCheck, ascii: boolean): Span {
  const g = glyphs(ascii);
  if (check.state === "passed") return { text: g.met, role: "ok" };
  if (check.state === "failed") return { text: g.failed, role: "err" };
  return { text: g.pending, role: "acc" };
}

/** The checks list at the left: a header, one row per check, then NEXT. */
function leftLines(
  item: BackgroundItem,
  focus: number,
  ascii: boolean,
  bar: string,
): (readonly Span[])[] {
  const detail = item.detail;
  if (detail === undefined) return [];
  const lines: (readonly Span[])[] = [[{ text: "CHECKS", role: "dim" }]];
  detail.checks.forEach((check, i) => {
    const on = i === focus;
    lines.push(
      focused(
        [
          on ? { text: bar, role: "acc" } : { text: " " },
          { text: " " },
          checkGlyph(check, ascii),
          on ? { text: ` ${check.name}`, role: "hi" } : { text: ` ${check.name}` },
          { text: " ".repeat(Math.max(0, LEFT - 4 - check.name.length)) },
        ],
        on,
      ),
    );
  });
  lines.push([], [{ text: "NEXT", role: "dim" }]);
  detail.next.forEach((line, i) => {
    lines.push([{ text: "  " }, i === 0 ? { text: line } : { text: line, role: "dim" }]);
  });
  return lines;
}

function logSpans(line: BackgroundLogLine): Span[] {
  return [
    line.at === undefined ? { text: " ".repeat(7) } : { text: `${time(line.at)}  `, role: "dim" },
    ...line.spans.map((span): Span => ({ text: span.text, role: span.tone })),
  ];
}

/** The focused check's heading, its log tail and the note code derived from every attempt. */
function rightLines(item: BackgroundItem, focus: number): (readonly Span[])[] {
  const detail = item.detail;
  const check = detail?.checks[focus];
  if (detail === undefined || check === undefined) return [];
  const facts = [
    check.state === "running"
      ? "running"
      : `${check.state}${check.at === undefined ? "" : ` ${time(check.at)}`}`,
    ...(check.seconds === undefined ? [] : [duration(check.seconds)]),
    "log tail",
  ];
  const lines: (readonly Span[])[] = [
    [
      { text: check.name, role: "hi", bold: true },
      { text: ` · ${facts.join(" · ")}`, role: "dim" },
    ],
    [],
    ...check.log.map(logSpans),
  ];
  if (detail.note !== undefined) lines.push([], [{ text: detail.note, role: "dim" }]);
  return lines;
}

/** The header's story line and the Pipeline under it, for the rooms slot of the Frame. */
export function BackgroundTitle(props: {
  readonly item: BackgroundItem;
  readonly title: string;
  readonly width: number;
  readonly display: Display;
}) {
  const { item, display } = props;
  const failed = item.state === "failed";
  const spans = pipelineSpans({
    phase: "merge",
    marks: { build: "met", review: "met", test: "met" },
    ...(failed ? { failed: { phase: "merge", check: "CI" } } : {}),
    ascii: display.ascii,
  });
  const status = item.detail?.status;
  return (
    <Box flexDirection="column">
      <SpanLine
        display={display}
        spans={[{ text: `${itemStory(item)} ${props.title}`.trimEnd(), role: "hi", bold: true }]}
      />
      <SpanLine
        display={display}
        spans={
          status === undefined ? spans : spread(spans, [{ text: status, role: "dim" }], props.width)
        }
      />
    </Box>
  );
}

/** The header of the level: `dipo / office / Floor / PR #698` and `● live` with the time. */
export function BackgroundHeader(props: {
  readonly office: string;
  readonly item: BackgroundItem;
  readonly live: boolean;
  readonly now: number;
  readonly width: number;
  readonly display: Display;
}) {
  const { display } = props;
  const g = glyphs(display.ascii);
  const right = [
    { text: g.live, role: props.live ? "ok" : "err" },
    { text: props.live ? " live" : " offline" },
    { text: `    ${clockTime(props.now)}`, role: "dim" },
  ] as const satisfies readonly Span[];
  const left: Span[] = [
    { text: "dipo", role: "acc", bold: true },
    { text: ` / ${props.office} / Floor / `, role: "dim" },
    { text: props.item.ref },
  ];
  return <SpanLine display={display} spans={spread(left, right, props.width)} />;
}

/** The two panes, `height` rows, divided by a faint rule. */
export function BackgroundDetailBody(props: {
  readonly item: BackgroundItem;
  readonly focus: number;
  readonly width: number;
  readonly height: number;
  readonly display: Display;
}) {
  const { item, focus, display, width, height } = props;
  const bar = glyphs(display.ascii).bar;
  const left = leftLines(item, focus, display.ascii, bar);
  const right = rightLines(item, focus);
  const rule = display.ascii ? "|" : "│";
  return (
    <Box flexDirection="column">
      {Array.from({ length: Math.max(0, height) }, (_, i) => {
        const cell = left[i] ?? [];
        const pad = Math.max(0, LEFT - spansText(cell).length);
        const text = right[i] ?? [];
        const spans: Span[] = [
          ...cell,
          { text: " ".repeat(pad) },
          { text: rule, role: "faint" },
          { text: "  " },
          ...text,
        ];
        return <SpanLine key={i} display={display} spans={cutSpans(spans, width)} />;
      })}
    </Box>
  );
}
