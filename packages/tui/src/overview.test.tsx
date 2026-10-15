// The office overview board (DIPO-54 and DIPO-81 test plans): frames of the approved layout at 120
// and 80 columns with running, needs-you, in-review and Ready rows, the two-line cards from 60 to
// 79, the idle line, the `now:` line following live output, `[q] quit` at every width, cutting
// the board to the height, and no line wider than the terminal.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  Event,
  OfficeId,
  OfficeSnapshot,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";

import { fitSections, type Section } from "./overview";
import { goldenSnapshots, OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const RUN_21 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function golden(): OfficeSnapshot {
  const snapshot = goldenSnapshots.get(OFFICES.dipsaus);
  if (snapshot === undefined) throw new Error("no dipsaus snapshot in the golden log");
  return snapshot;
}

/**
 * The approved proposal's scenario on top of the golden office: DIPO-26 parked on a permission,
 * DIPO-28 In Review, DIPO-19 asking a question, and DIPO-24's last output 12 s before the test
 * clock (10:04:00).
 */
function boardSnapshot(): OfficeSnapshot {
  const base = golden();
  const parked = {
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C26",
    story: "DIPO-26",
    provisional: false,
    title: "Compose dev stack",
    lifecycle: "Parked",
    tier: "M",
    column: "desk",
    parked: {
      reason: "needs-permission",
      detail: "Bash(docker compose up)",
      from: "In Progress",
      since: "2026-10-14T09:24:00.000Z",
    },
  } as StoryView;
  const review = {
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C28",
    story: "DIPO-28",
    provisional: false,
    title: "Show the merge queue",
    lifecycle: "In Review",
    tier: "L",
    column: "review",
  } as StoryView;
  const work = base.work.map((view) =>
    view.work.story === "DIPO-24" ? { ...view, lastOutputAt: "2026-10-14T10:03:48.000Z" } : view,
  ) as WorkView[];
  const asking = base.work.find((view) => view.work.story === "DIPO-19")!;
  return {
    ...base,
    stories: [...base.stories, parked, review],
    work,
    questions: [
      {
        question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C19",
        work: asking.work,
        kind: "question",
        text: "Keep the old merge slot?",
        askedAt: "2026-10-14T10:00:00.000Z",
      },
    ],
  } as OfficeSnapshot;
}

/** Nothing runs: DIPO-31 waits on DIPO-21, DIPO-33 fails R15, DIPO-29 is on hold, one draft. */
function idleSnapshot(): OfficeSnapshot {
  const base = golden();
  return {
    ...base,
    work: [],
    stories: base.stories.filter((story) =>
      ["waiting", "refined", "held", "draft", "done"].includes(story.column),
    ),
  };
}

async function open(
  columns: number,
  rows = 30,
  snapshot: OfficeSnapshot | null = null,
  capabilities?: readonly string[],
) {
  const view = await mount({
    columns,
    rows,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(snapshot === null
      ? {}
      : { snapshots: new Map<OfficeId, OfficeSnapshot>([[OFFICES.dipsaus, snapshot]]) }),
  });
  mounted.push(view.ui);
  await view.ui.waitFor("· live");
  return view;
}

function outputEvent(seq: number, run: string, source: string, from: number, text: string) {
  const view = golden().work.find((candidate) => candidate.work.run === run)!;
  return {
    cursor: { stream: STREAM, epoch: "e2", seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "work.output",
    data: { work: view.work, source, from, to: from + text.length, text },
  } as Event;
}

describe("office overview board", () => {
  it("shows the approved layout at 120 columns", async () => {
    const { ui } = await open(120, 30, boardSnapshot());
    const frame = await ui.waitFor("running verify · expected 3, received 4");
    expect(lines(frame)).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " 3 running · 2 needs you · 1 in review · Ready 2 · waiting 1 · held 1",
      " RUNNING (3)",
      ">DIPO-21 Stream worker events to th… developer M  build   busy >     AC 4/7  loop 2/5  [####----] 52% 38m  claude-sonnet",
      "     now: building · no output yet",
      " DIPO-24 Add verify retry            developer S  verify  looping @  AC 2/3  loop 2/3  [######--] 78% 22m  claude-sonnet",
      "     now: running verify · expected 3, received 4 · 12s ago",
      " DIPO-19 Review the merge slot       reviewer L   review  ASKING ?   AC 9/9  loop 1/8  [#-------] 18% 1h05 claude-opus",
      "     now: asking you · Keep the old merge slot?",
      " NEEDS YOU (1)",
      " DIPO-26 Compose dev stack            parked 40m · needs permission: Bash(docker compose up)",
      " IN REVIEW (1)",
      " DIPO-28 Show the merge queue         L  in review · no worker running",
      " READY (2)",
      " DIPO-30 Add park reasons to digest   S  Ready · [2] queue, then u",
      " DIPO-32 Desk sort order              M  Ready",
      " [Enter] detail  [j/k] move  [2] queue  [o] offices  [q] quit",
    ]);
  });

  it("drops role, loop and model from 80 to 119 columns", async () => {
    const { ui } = await open(80, 30, boardSnapshot());
    const frame = await ui.waitFor("running verify · expected 3, received 4");
    expect(lines(frame)).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " 3 running · 2 needs you · 1 in review · Ready 2 · waiting 1 · held 1",
      " RUNNING (3)",
      ">DIPO-21 Stream worker events … build  busy >    AC 4/7 [####----] 52% 38m",
      "     now: building · no output yet",
      " DIPO-24 Add verify retry       verify looping @ AC 2/3 [######--] 78% 22m",
      "     now: running verify · expected 3, received 4 · 12s ago",
      " DIPO-19 Review the merge slot  review ASKING ?  AC 9/9 [#-------] 18% 1h05",
      "     now: asking you · Keep the old merge slot?",
      " NEEDS YOU (1)",
      " DIPO-26 Compose dev stack       parked 40m · needs permission: Bash(docker com…",
      " IN REVIEW (1)",
      " DIPO-28 Show the merge queue    in review · no worker running",
      " READY (2)",
      " DIPO-30 Add park reasons to d…  Ready · [2] queue, then u",
      " DIPO-32 Desk sort order         Ready",
      " [Enter] detail  [j/k] move  [2] queue  [o] offices  [q] quit",
    ]);
  });

  it("shows two-line cards from 60 to 79 columns with the now text on the second line", async () => {
    const { ui } = await open(70, 30, boardSnapshot());
    const frame = await ui.waitFor("running verify · expected 3, received 4");
    expect(frame).toContain(
      " DIPO-24  looping @  verify  AC 2/3  loop 2/3  [######--] 78%  Add ve…\n   now: running verify · expected 3, received 4 · 12s ago",
    );
    expect(frame).toContain(" NEEDS YOU (1)");
    expect(frame).not.toContain("STORY");
  });

  it("says why nothing runs when the office is idle", async () => {
    const { ui } = await open(120, 30, idleSnapshot());
    expect(lines(ui.frame())).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " 0 running · 2 needs you · 0 in review · Ready 0 · waiting 1 · held 1",
      " Nothing is running and nothing is Ready: DIPO-31 waits on DIPO-21, DIPO-33 is Refined (R15), DIPO-29 is on hold, 1 dra…",
      " [2] queue  [o] offices  [q] quit",
    ]);
  });

  it("points at the queue when Ready stories wait and nothing runs", async () => {
    const base = golden();
    const { ui } = await open(120, 30, { ...base, work: [] });
    const frame = ui.frame();
    expect(frame).toContain(" Nothing is running. Ready 2: [2] queue, then u to run one.");
    expect(frame).toContain(" READY (2)");
  });

  it("follows live output on the now line, and its age moves with the clock", async () => {
    const { ui, session, clock } = await open(120, 30, boardSnapshot());
    await ui.waitFor("running verify · expected 3, received 4 · 12s ago");
    session.storeOutput(outputEvent(8, RUN_21, "worker", 0, "[tool] Edit src/stream.ts\n"));
    await ui.waitFor("now: building · [tool] Edit src/stream.ts");
    session.storeOutput(outputEvent(9, RUN_21, "worker", 26, "Streaming now works.\n"));
    await ui.waitFor("now: building · Streaming now works.");
    // Verify output leads in the verify phase.
    const run24 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";
    const stored = session.output.get(`${run24}:verify`)!.length;
    session.storeOutput(outputEvent(10, run24, "verify", stored, "PASS test/retry.test.ts\n"));
    await ui.waitFor("now: running verify · PASS test/retry.test.ts · 12s ago");
    clock.advance(60_000);
    await ui.waitFor("now: running verify · PASS test/retry.test.ts · 1m ago", 2_000);
  });

  it("reads the stored tails once when the office opens, not on every render", async () => {
    const { ui, session } = await open(120, 30, boardSnapshot());
    await ui.waitFor("expected 3, received 4");
    const reads = () => session.reads.filter((read) => read.name === "work.outputRange").length;
    const before = reads();
    // Three runs, worker and verify each: a read to the end and at most one empty read after it.
    expect(before).toBeGreaterThanOrEqual(6);
    expect(before).toBeLessThanOrEqual(12);
    await ui.press("j");
    await ui.press("k");
    await Bun.sleep(150);
    expect(reads()).toBe(before);
  });

  it("marks claimed values and shows the legend with the evidence capability", async () => {
    const { ui } = await open(120, 30, null, ["evidence"]);
    const frame = ui.frame();
    expect(frame).toContain("verify  looping @  AC 2/3*  loop 2/3  [######--] 78%* 22m");
    expect(frame).toContain("* claimed ~ estimated ? none");
    for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(120);
  });

  it("keeps [q] quit visible and no line wider than the terminal at every width", async () => {
    for (const columns of [120, 100, 80, 79, 70, 60]) {
      for (const rows of [30, 16]) {
        const { ui } = await open(columns, rows, boardSnapshot());
        const shown = lines(ui.frame());
        expect(shown.at(-1)).toContain("[q] quit");
        expect(shown.length).toBeLessThanOrEqual(rows);
        for (const line of shown) expect(line.length).toBeLessThanOrEqual(columns);
        await ui.press("2");
        await ui.waitFor("next Ready story");
        expect(ui.frame()).toContain("[q] quit");
      }
    }
  });

  it("cuts the board to the height and keeps the selected run on screen", async () => {
    const { ui } = await open(120, 16, boardSnapshot());
    const first = lines(ui.frame());
    expect(first).toContain(" RUNNING (3)");
    expect(first.length).toBeLessThanOrEqual(16);
    await ui.press("j");
    await ui.press("j");
    const frame = await ui.waitFor(">DIPO-19");
    expect(lines(frame).length).toBeLessThanOrEqual(16);
    expect(frame).toContain("[q] quit");
  });

  it("follows a work event with a new view", async () => {
    const { ui, session } = await open(120);
    const stream = session.active(STREAM);
    const before = golden().work[1]!;
    const view = { ...before, phase: "review", health: "busy" };
    stream?.options.onEvent({
      cursor: { stream: STREAM, epoch: "e2", seq: 8 },
      at: "2026-10-14T10:05:00.000Z",
      type: "work.phase",
      data: { work: view.work, phase: "review", progress: view.progress, view },
    } as never);
    const frame = await ui.waitFor("developer S  review  busy >");
    expect(frame).toContain("now: reviewing ·");
  });
});

function row(key: string, size: number) {
  return {
    key,
    lines: Array.from({ length: size }, (_, i) => ({ key: `${key}${i}`, text: `${key}${i}` })),
  };
}

describe("fitSections", () => {
  const list: Section[] = [
    { title: "RUNNING", rows: [row("a", 2), row("b", 2), row("c", 2)], keep: 2 },
    { title: "READY", rows: [row("r", 1)] },
  ];

  it("shows every section that fits", () => {
    expect(fitSections(list, 20, "…").map((line) => line.text)).toEqual([
      " RUNNING (3)",
      "a0",
      "a1",
      "b0",
      "b1",
      "c0",
      "c1",
      " READY (1)",
      "r0",
    ]);
  });

  it("cuts a section to whole rows with the kept row and a more line, and drops the rest", () => {
    expect(fitSections(list, 5, "…").map((line) => line.text)).toEqual([
      " RUNNING (3)",
      "c0",
      "c1",
      "   … 2 more",
    ]);
  });
});
