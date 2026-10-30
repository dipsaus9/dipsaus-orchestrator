// The test checklist (`4`, DIPO-365, 0002, 0009): the manual steps of a story's open test, in
// order, with local ticks that the engine never sees. The open test comes from the office store
// (`test.started`, `test.recorded`, `test.ended`); the TUI does not derive it. `P` passes the test
// and `F` fails it with a note that starts as the first unticked step (`actions.ts`); Esc leaves
// the view and the test open.

import type { TestStep, TestView } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";

import { truncate } from "./format";
import type { Display } from "./options";
import { glyphs } from "./views";

/** The first step not ticked, which a fail note starts with; undefined when all are ticked. */
export function firstUnticked(steps: readonly TestStep[], ticked: readonly number[]) {
  return steps.find((_, index) => !ticked.includes(index));
}

interface ChecklistProps {
  /** The open test to show; null when none is open. */
  readonly test: TestView | null;
  /** Said in place of the steps when no test is open. */
  readonly empty: string;
  /** The indexes of the steps ticked on this screen. */
  readonly ticked: readonly number[];
  /** The step the cursor is on. */
  readonly step: number;
  readonly display: Display;
  readonly columns: number;
}

export function Checklist(props: ChecklistProps) {
  const { test, ticked, step, display, columns } = props;
  const { ellipsis } = glyphs(display.ascii);
  if (test === null) return <Text wrap="truncate-end">{` ${props.empty}`}</Text>;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{` Test of ${test.story}: ${test.checkout} at ${test.head.slice(0, 7)}`}</Text>
      {test.url === undefined ? null : <Text wrap="truncate-end">{` open ${test.url}`}</Text>}
      {test.steps.length === 0 ? (
        <Text>{" no manual steps; P passes the test, F fails it"}</Text>
      ) : null}
      {test.steps.map((manual, index) => {
        const mark = ticked.includes(index) ? "x" : " ";
        const expect = manual.expect === undefined ? "" : ` -> ${manual.expect}`;
        const line = `${index === step ? ">" : " "} [${mark}] ${index + 1}. ${manual.check}${expect}`;
        return (
          <Text key={index} wrap="truncate-end">
            {` ${truncate(line, Math.max(0, columns - 2), ellipsis)}`}
          </Text>
        );
      })}
    </Box>
  );
}
