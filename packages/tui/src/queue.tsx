// The Queue (`3`, 0009, DIPO-460): what is next and why it waits. The list has three groups, READY,
// WAITING ON A DEPENDENCY and REFINED · not Ready yet, each row with its tier and a reason column:
// `next up`, `needs 447✗` (the dependency is parked, yours to clear), `needs 452→` (it moves by
// itself), a bare `needs 449` (it waits too), or the first failed Ready gate rule. From 100
// columns the preview of the selected story sits at the right: its gate (`✓ 31 rules`), needs,
// unblocks, touches and the CHAIN picture, with a pointer to the Desk when a park blocks the
// chain. Everything in the preview is what the engine sent (`story.gate`, `office.chain`). `.`
// shows the Done stories (N). Rows are cut to the width.

import type { StoryView } from "@dipsaus-orchestrator/contract";
import { Box } from "ink";

import {
  type Chain,
  chainPictureSpans,
  type GateFacts,
  needsSpans,
  refinedLines,
  shortId,
} from "./chain";
import { truncate } from "./format";
import type { Display } from "./options";
import { cutSpans, focused, type Span, SpanLine, spread } from "./spans";
import { glyphs } from "./views";

export type QueueGroup = "ready" | "waiting" | "refined" | "done";

/** The groups in screen order, with their headings. */
const GROUPS: readonly { readonly group: QueueGroup; readonly title: string }[] = [
  { group: "ready", title: "READY" },
  { group: "waiting", title: "WAITING ON A DEPENDENCY" },
  { group: "refined", title: "REFINED · not Ready yet" },
  { group: "done", title: "DONE" },
];

/** The list's width beside a preview, and the preview's gap to it. */
export const LIST_WIDTH = 62;
export const SPLIT_COLUMNS = 100;
const REASON_WIDTH = 13;
const LABEL_WIDTH = 9;

/** One selectable row of the queue. */
export interface QueueRow {
  readonly view: StoryView;
  readonly group: QueueGroup;
  /** The first Ready story: the one `R` starts first and the engine offers as next up. */
  readonly nextUp: boolean;
}

/** The selectable rows: each group's stories in the engine's order; Done only when `showDone`. */
export function queueRows(stories: readonly StoryView[], showDone: boolean): QueueRow[] {
  return GROUPS.filter(({ group }) => group !== "done" || showDone).flatMap(({ group }) =>
    stories
      .filter((story) => story.column === group)
      .map((view, i) => ({ view, group, nextUp: group === "ready" && i === 0 })),
  );
}

/** How many stories are Done, for `. show done (N)`. */
export function doneCount(stories: readonly StoryView[]): number {
  return stories.filter((story) => story.column === "done").length;
}

/** The first failed Ready gate rule's text of a Refined story; the message when no rule gave one. */
function gateReason(view: StoryView): string {
  const failure = view.gateFailures?.[0];
  return failure === undefined ? (view.gateMessages?.[0] ?? "") : failure.text;
}

interface Layout {
  readonly width: number;
  readonly idWidth: number;
  readonly titleWidth: number;
  readonly reasonWidth: number;
}

function layoutOf(rows: readonly QueueRow[], width: number, split: boolean): Layout {
  const idWidth = Math.max(8, ...rows.map((row) => String(row.view.story).length));
  const prefix = 4 + idWidth + 2;
  const reasonWidth = split ? REASON_WIDTH : Math.min(18, Math.max(0, width - prefix - 3 - 20));
  return { width, idWidth, titleWidth: Math.max(0, width - prefix - 3 - reasonWidth), reasonWidth };
}

function reasonSpans(row: QueueRow, layout: Layout, chain: Chain, ascii: boolean): Span[] {
  const { view } = row;
  if (row.group === "ready") {
    return row.nextUp ? [{ text: "next up", role: "ok" }] : [{ text: "ready", role: "dim" }];
  }
  if (row.group === "waiting") {
    return [{ text: "needs ", role: "dim" }, ...needsSpans(view.waitingOn ?? [], chain, ascii)];
  }
  if (row.group === "refined") {
    const ellipsis = glyphs(ascii).ellipsis;
    return [{ text: truncate(gateReason(view), layout.reasonWidth, ellipsis), role: "dim" }];
  }
  return [{ text: "done", role: "dim" }];
}

/** One story row of the list. */
function rowSpans(
  row: QueueRow,
  layout: Layout,
  selected: boolean,
  chain: Chain,
  display: Display,
): Span[] {
  const g = glyphs(display.ascii);
  const { view } = row;
  const glyph: Span =
    row.group === "ready"
      ? { text: display.ascii ? ">" : "→", role: "ok" }
      : row.group === "waiting"
        ? { text: g.idle, role: "acc" }
        : row.group === "refined"
          ? { text: g.failed, role: "err" }
          : { text: g.met, role: "dim" };
  const reason = cutSpans(reasonSpans(row, layout, chain, display.ascii), layout.reasonWidth);
  const title = truncate(view.title, layout.titleWidth - 1, g.ellipsis).padEnd(layout.titleWidth);
  return [
    { text: selected ? g.bar : " ", role: "acc" },
    { text: " " },
    glyph,
    { text: " " },
    { text: String(view.story).padEnd(layout.idWidth + 2), role: "dim" },
    selected ? { text: title, role: "hi" } : { text: title },
    { text: (view.tier ?? " ").padEnd(3), role: "dim" },
    ...reason,
  ];
}

interface ListLine {
  readonly key: string;
  readonly spans: readonly Span[];
  readonly row: number | null;
}

/** The list's lines: group headings with their counts, their rows, and the done toggle. */
function listLines(options: {
  rows: readonly QueueRow[];
  selected: number;
  layout: Layout;
  chain: Chain;
  display: Display;
  showDone: boolean;
  doneTotal: number;
}): ListLine[] {
  const { rows, layout, display } = options;
  const lines: ListLine[] = [];
  for (const { group, title } of GROUPS) {
    const members = rows.map((row, index) => ({ row, index })).filter((m) => m.row.group === group);
    if (members.length === 0) continue;
    if (lines.length > 0) lines.push({ key: `gap:${group}`, spans: [], row: null });
    lines.push({
      key: `head:${group}`,
      row: null,
      spans: spread(
        [{ text: display.ascii ? title.replace("·", "-") : title, role: "hi", bold: true }],
        [{ text: `${members.length}  `, role: "dim" }],
        layout.width,
      ),
    });
    for (const { row, index } of members) {
      lines.push({
        key: String(row.view.key),
        row: index,
        spans: rowSpans(row, layout, index === options.selected, options.chain, display),
      });
    }
  }
  if (options.doneTotal > 0) {
    if (lines.length > 0) lines.push({ key: "gap:done-toggle", spans: [], row: null });
    lines.push({
      key: "toggle",
      row: null,
      spans: [
        {
          text: `  . ${options.showDone ? "hide" : "show"} done (${options.doneTotal})`,
          role: "dim",
        },
      ],
    });
  }
  return lines;
}

/** `text` cut into lines of at most `width` characters at spaces. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** What the preview needs: the chain, and the gate of the selected story as far as it is read. */
interface PreviewInput {
  readonly row: QueueRow;
  readonly chain: Chain;
  readonly gate: GateFacts | null | undefined;
  readonly width: number;
  readonly display: Display;
}

const label = (text: string): Span => ({ text: text.padEnd(LABEL_WIDTH), role: "dim" });

function gateSpans(input: PreviewInput): Span[] {
  const { gate, row, display } = input;
  const g = glyphs(display.ascii);
  if (gate === undefined) return [{ text: g.ellipsis, role: "dim" }];
  if (gate === null) return [{ text: "unavailable", role: "dim" }];
  if (!gate.passed) {
    const failure = gate.failures[0];
    const own = row.view.gateFailures?.find((entry) => entry.rule === failure?.rule);
    return [
      { text: g.failed, role: "err" },
      { text: ` ${failure?.rule ?? ""} ${own?.text ?? failure?.message ?? ""}`.trimEnd() },
    ];
  }
  const warnings = gate.warnings ?? [];
  const spans: Span[] = [{ text: g.met, role: "ok" }, { text: ` ${gate.rules} rules` }];
  if (warnings.length > 0) {
    spans.push(
      { text: ` ${g.dot} ` },
      { text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`, role: "acc" },
      { text: ` ${warnings[0]?.rule ?? ""}` },
    );
  }
  return spans;
}

/** The dim line over the title: the group, the tier and, for the next up story, that it is offered. */
function kindLine(row: QueueRow, dot: string): string {
  const tier = row.view.tier === undefined ? [] : [`tier ${row.view.tier}`];
  const kind =
    row.group === "ready"
      ? ["READY", ...tier, ...(row.nextUp ? ["offered as next up"] : [])]
      : row.group === "waiting"
        ? ["WAITING ON A DEPENDENCY", ...tier]
        : row.group === "refined"
          ? ["REFINED", "not Ready yet", ...tier]
          : ["DONE"];
  return kind.join(` ${dot} `);
}

/** The CHAIN picture of every piece, and where to clear a park that blocks one. */
function chainLines(chain: Chain, display: Display): Span[][] {
  if (chain.rows.length === 0) return [];
  const g = glyphs(display.ascii);
  const arrow = display.ascii ? "->" : "→";
  const lines: Span[][] = [[], [{ text: "CHAIN", role: "dim" }]];
  for (const piece of chain.rows) {
    lines.push(chainPictureSpans(piece, chain, arrow, g.dot, display.ascii));
  }
  const parked = chain.rows.find((piece) => piece.parked !== undefined)?.parked;
  if (parked !== undefined) {
    lines.push(
      [],
      [{ text: `Everything below ${shortId(parked)} waits on the park`, role: "dim" }],
      [
        { text: "on your Desk. ", role: "dim" },
        { text: "1", role: "acc" },
        { text: " go there.", role: "dim" },
      ],
    );
  }
  return lines;
}

/** The preview's lines: the kind, the title, the labelled facts, the chain and where to fix it. */
function previewLines(input: PreviewInput): Span[][] {
  const { row, chain, gate, width, display } = input;
  const g = glyphs(display.ascii);
  const { view } = row;
  const lines: Span[][] = [[{ text: kindLine(row, g.dot), role: "dim" }]];
  for (const text of wrap(`${view.story} ${view.title}`, Math.min(60, width))) {
    lines.push([{ text, role: "hi", bold: true }]);
  }
  lines.push([]);
  const waitingOn = view.waitingOn ?? [];
  if (row.group === "waiting" && waitingOn.length > 0) {
    lines.push([{ text: `Waiting on ${waitingOn.join(", ")}`, role: "dim" }], []);
  }
  const node = chain.nodes.find((candidate) => candidate.story === view.story);
  lines.push([label("Gate"), ...gateSpans(input)]);
  lines.push([
    label("Needs"),
    ...(waitingOn.length === 0
      ? [{ text: "all done", role: "ok" as const }]
      : needsSpans(waitingOn, chain, display.ascii)),
  ]);
  for (const text of refinedLines(waitingOn, chain)) {
    lines.push([label("Refined"), { text, role: "acc" }]);
  }
  const unblocks = node?.unblocks ?? [];
  lines.push([label("Unblocks"), { text: unblocks.length === 0 ? "-" : unblocks.join(", ") }]);
  const touches = gate === undefined || gate === null ? [] : (gate.touches ?? []);
  if (touches.length === 0) lines.push([label("Touches"), { text: "-", role: "dim" }]);
  touches.forEach((path, i) => {
    lines.push([i === 0 ? label("Touches") : { text: " ".repeat(LABEL_WIDTH) }, { text: path }]);
  });
  lines.push(...chainLines(chain, display));
  return lines;
}

/** The lines that stay on screen: from the top, moved down so the selected row shows. */
function windowOf<T extends { readonly row: number | null }>(
  lines: readonly T[],
  height: number,
  selected: number,
): readonly T[] {
  if (lines.length <= height) return lines;
  const at = lines.findIndex((line) => line.row === selected);
  const start = at === -1 ? 0 : Math.max(0, Math.min(lines.length - height, at + 1 - height));
  return lines.slice(start, start + height);
}

export function Queue(props: {
  rows: readonly QueueRow[];
  selected: number;
  display: Display;
  columns: number;
  height: number;
  /** The dependency chain the engine sent. */
  chain: Chain;
  /** The selected story's gate: undefined while it is read, null when it could not be. */
  gate: GateFacts | null | undefined;
  showDone: boolean;
  doneTotal: number;
}) {
  const { rows, selected, display, chain, gate } = props;
  const width = props.columns - 1;
  const split = props.columns >= SPLIT_COLUMNS;
  const layout = layoutOf(rows, split ? LIST_WIDTH : width, split);
  const list = listLines({
    rows,
    selected,
    layout,
    chain,
    display,
    showDone: props.showDone,
    doneTotal: props.doneTotal,
  });
  const shown = windowOf(list, Math.max(1, props.height), selected);
  const chosen = rows[selected];
  const previewWidth = Math.max(0, width - LIST_WIDTH - 3);
  const preview =
    split && chosen !== undefined
      ? previewLines({ row: chosen, chain, gate, width: previewWidth, display })
      : [];
  const pane = display.ascii ? "|" : "│";
  return (
    <Box flexDirection="column">
      {rows.length === 0 && props.doneTotal === 0 ? (
        <SpanLine spans={[{ text: " The queue is empty.", role: "dim" }]} display={display} />
      ) : null}
      {Array.from({ length: Math.max(1, props.height) }, (_, i) => {
        const line = shown[i];
        const left = line === undefined ? [] : line.spans;
        const right = preview[i] ?? [];
        const selectedRow = line !== undefined && line.row === selected;
        if (!split) {
          return line === undefined ? null : (
            <SpanLine
              key={line.key}
              spans={cutSpans(focused(spread(left, [], width), selectedRow), width)}
              display={display}
            />
          );
        }
        const padded = focused(spread(left, [], layout.width), selectedRow);
        return (
          <SpanLine
            key={line?.key ?? `pad:${i}`}
            spans={cutSpans(
              [
                ...cutSpans(padded, layout.width),
                { text: pane, role: "faint" },
                { text: "  " },
                ...cutSpans(right, previewWidth),
              ],
              width,
            )}
            display={display}
          />
        );
      })}
    </Box>
  );
}
