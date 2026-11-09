// The test overlay (`t` on a MERGE item, DIPO-365, DIPO-462, 0002, 0009; screens/10-test-overlay.txt):
// the manual steps of a story's open test, in order, in a box over the shaded Desk, with local
// ticks that the engine never sees. The open test comes from the office store (`test.started`,
// `test.recorded`, `test.ended`); the TUI does not derive it. `y` passes the test and `n` fails it
// with a note that starts as the first unticked step (`actions.ts`); `c` copies the shell line; Esc
// hides the overlay and the test stays open. It names the story by its id, and shows the test's
// `url` and its `dipo test shell <ID>` line when the test carries them (DIPO-421). A test that
// closed on its own says why (`endedWords`).

import type { TestStep, TestView } from "@dipsaus-orchestrator/contract";
import { Box } from "ink";

import { wrapWords } from "./format";
import type { Display } from "./options";
import { boxGlyphs } from "./palette";
import { type Seg, type SegLine, fitLine, SegRow, seg, spread } from "./segments";

/** The measure of the box's text; the box is this and four more columns wide. */
export const TEST_INNER = 84;

/** The first step not ticked, which a fail note starts with; undefined when all are ticked. */
export function firstUnticked(steps: readonly TestStep[], ticked: readonly number[]) {
  return steps.find((_, index) => !ticked.includes(index));
}

const END_WORDS: Readonly<Record<string, string>> = {
  "new-head": "a new head was pushed",
  idle: "it sat idle too long",
  dropped: "the story was dropped",
  discarded: "the story was discarded",
  merged: "the story was merged",
  "not-in-review": "the story left review",
  "box-lost": "its box was lost",
  "start-failed": "its start failed",
};

/** Why a test closed, in words (`test.ended`'s reason); an unknown reason is said as it is. */
export function endedWords(reason: string): string {
  return END_WORDS[reason] ?? reason;
}

interface ChecklistProps {
  /** The open test to show; null when none is open. */
  readonly test: TestView | null;
  /** Said in place of the steps when no test is open. */
  readonly empty: string;
  /** Why the test closed, when a `test.ended` for it was seen; said under `empty`. */
  readonly ended?: string | null;
  /** The indexes of the steps ticked on this screen. */
  readonly ticked: readonly number[];
  /** The step the cursor is on. */
  readonly step: number;
  readonly display: Display;
  readonly columns: number;
}

/** The lines inside the box, each `TEST_INNER` columns of text. */
export function checklistLines(props: ChecklistProps): SegLine[] {
  const { test, ticked, step, display } = props;
  const ascii = display.ascii;
  const rule: SegLine = [seg("─".repeat(TEST_INNER), "faint")];
  if (test === null) {
    return [
      [seg("TEST", "hi", true)],
      ...wrapWords(props.empty, TEST_INNER).map((line): SegLine => [seg(line, "dim")]),
      ...(props.ended == null
        ? []
        : wrapWords(`It closed because ${props.ended}.`, TEST_INNER).map((line): SegLine => [
            seg(line, "dim"),
          ])),
      rule,
      [seg("esc", "acc"), seg(" hide")],
    ];
  }
  const lines: SegLine[] = [
    spread(
      [
        seg("TEST", "hi", true),
        seg(` · ${test.story} at ${test.head.slice(0, 7)} · box ${test.checkout}`, "dim"),
      ],
      [seg(ascii ? "* " : "● ", "ok"), seg("running", "ok")],
      TEST_INNER,
    ),
  ];
  if (test.url !== undefined) {
    lines.push([
      seg("open   ", "dim"),
      { ...seg(test.url, "acc"), underline: true },
      seg("   o opens", "dim"),
    ]);
  }
  if (test.shell !== undefined) {
    lines.push([seg("shell  ", "dim"), seg(test.shell), seg("          c copies", "dim")]);
  }
  lines.push(rule);
  if (test.steps.length === 0) lines.push([seg("no manual steps; y passes the test, n fails it")]);
  test.steps.forEach((manual, index) => {
    const on = ticked.includes(index);
    const bar = index === step ? (ascii ? ">" : "▌") : " ";
    const mark = on ? (ascii ? "x" : "✓") : ascii ? "o" : "○";
    const head = `${bar} ${mark} ${index + 1} `;
    const room = TEST_INNER - head.length;
    const checks = wrapWords(manual.check, room);
    const expects =
      manual.expect === undefined ? [] : wrapWords(`${ascii ? "->" : "→"} ${manual.expect}`, room);
    const rows: SegLine[] = [
      ...checks.map((text, i): SegLine => [
        i === 0 ? seg(`${bar} `, "acc") : seg("  "),
        ...(i === 0
          ? [seg(`${mark} ${index + 1} `, on ? "ok" : "acc")]
          : [seg(" ".repeat(head.length - 2))]),
        seg(text, index === step ? "hi" : on ? "dim" : undefined),
      ]),
      ...expects.map((text): SegLine => [seg(" ".repeat(head.length)), seg(text, "dim")]),
    ];
    for (const row of rows) {
      const padded = fitLine(row, TEST_INNER);
      lines.push(index === step ? padded.map((piece): Seg => ({ ...piece, sel: true })) : padded);
    }
  });
  lines.push(
    rule,
    spread(
      [
        seg("space", "acc"),
        seg(" tick   "),
        seg("y", "acc"),
        seg(" pass   "),
        seg("n", "acc"),
        seg(" fail…   "),
        seg(ascii ? "up/down" : "↑↓", "acc"),
        seg(" step"),
      ],
      [seg("esc", "acc"), seg(" hide · test stays open", "dim")],
      TEST_INNER,
    ),
  );
  return lines;
}

/** The box over the Desk: the overlay's lines in an acc border, centred in `columns`. */
export function Checklist(props: ChecklistProps) {
  const { display } = props;
  const g = boxGlyphs(display.ascii);
  const width = TEST_INNER + 4;
  const margin = Math.max(0, Math.floor((props.columns - width - 2) / 2));
  const edge = (left: string, right: string): SegLine => [
    seg(left + g.h.repeat(width) + right, "acc"),
  ];
  const rows: SegLine[] = [
    edge(g.tl, g.tr),
    ...checklistLines(props).map((line): SegLine => [
      seg(g.v, "acc"),
      seg("  "),
      ...fitLine(line, TEST_INNER),
      seg("  "),
      seg(g.v, "acc"),
    ]),
    edge(g.bl, g.br),
  ];
  return (
    <Box flexDirection="column">
      {rows.map((line, i) => (
        <Box key={i} marginLeft={margin}>
          <SegRow line={line} display={display} />
        </Box>
      ))}
    </Box>
  );
}
