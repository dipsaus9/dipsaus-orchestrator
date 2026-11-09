// The Floor (DIPO-54, DIPO-81 and DIPO-460 test plans): the ux-spec's S2 frame cell for cell,
// RUNNING and IN REVIEW exclusive, health only when it needs the maintainer, the idle line, the
// `now` line following live output, `q q quit` at every width, cutting the board to the height,
// no line wider than the terminal, and opening any card.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  Event,
  OfficeId,
  OfficeSnapshot,
  RunRecord,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import { floorStories } from "./overview";
import { goldenHello, goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mockRows } from "../test/support/mock-screens";
import { mount } from "../test/support/setup";
import { officeCells } from "./views";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const RUN_21 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

/** The Frame's bands (DIPO-458): header, rooms and a rule above the body; a rule and the keys under it. */
const HEADER = expect.stringMatching(
  /^dipo \/ dipsaus-orchestrator .*● daemon live {4}\d\d:\d\d$/,
) as unknown as string;
const ROOMS = expect.stringMatching(/^1 Desk .*4 Retro$/) as unknown as string;
const RULE = expect.stringMatching(/^─+$/) as unknown as string;

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
 * DIPO-28 In Review, DIPO-19 quiet with an open question, and DIPO-24's last output 12 s before the test
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

/** Nothing runs: DIPO-31 waits on DIPO-21, DIPO-33 fails R15, DIPO-29 is parked by you, one draft. */
function idleSnapshot(): OfficeSnapshot {
  const base = golden();
  return {
    ...base,
    work: [],
    stories: base.stories.filter(
      (story) =>
        ["waiting", "refined", "draft", "done"].includes(story.column) || story.story === "DIPO-29",
    ),
  };
}

/** The idle snapshot with its one Refined story changed by `story`. */
function withRefined(story: (view: StoryView) => StoryView): OfficeSnapshot {
  const base = idleSnapshot();
  return {
    ...base,
    stories: base.stories.map((view) => (view.column === "refined" ? story(view) : view)),
  };
}

async function open(columns: number, rows = 30, snapshot: OfficeSnapshot | null = null) {
  const view = await mount({
    columns,
    rows,
    ...(snapshot === null
      ? {}
      : { snapshots: new Map<OfficeId, OfficeSnapshot>([[OFFICES.dipsaus, snapshot]]) }),
  });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  return view;
}

function outputEvent(seq: number, run: string, source: string, from: number, text: string) {
  const view = golden().work.find((candidate) => candidate.work.run === run)!;
  return {
    cursor: { stream: STREAM, seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "work.output",
    data: { work: view.work, source, from, to: from + text.length, text },
  } as Event;
}

/** The part of a snapshot the Floor reads, as a store state. */
function storeState(snapshot: OfficeSnapshot): OfficeStoreState {
  return {
    stories: snapshot.stories,
    work: snapshot.work,
    gates: snapshot.gates,
  } as unknown as OfficeStoreState;
}

/** One running run on top of the golden work view `base`: story, title, phase and what the card shows. */
function floorWork(
  base: WorkView,
  n: number,
  fields: Partial<WorkView> & { phase: string; model: string },
): WorkView {
  const id = String(n).padStart(2, "0");
  const { model, ...rest } = fields;
  return {
    ...base,
    ...rest,
    work: {
      ...base.work,
      story: `DIPO-4${id}`,
      key: `sto_01J9ZK5Q8W3V4X6Y7Z8A9B0D${id}`,
      run: `run_01J9ZK5Q8W3V4X6Y7Z8A9B0D${id}`,
      model,
    },
    health: "busy",
  } as WorkView;
}

const waiting = (n: number, on: number): StoryView =>
  ({
    key: `sto_01J9ZK5Q8W3V4X6Y7Z8A9B0E${n}`,
    story: `DIPO-${n}`,
    provisional: false,
    title: `Waiting story ${n}`,
    lifecycle: "Ready",
    tier: "M",
    column: "waiting",
    waitingOn: [`DIPO-${on}`],
  }) as StoryView;

const level = (...ids: number[]) => ids.map((n) => `DIPO-${n}`);

const floorStory = (view: WorkView, title: string, lifecycle: string, column: string) =>
  ({
    key: view.work.key,
    story: view.work.story,
    provisional: false,
    title,
    lifecycle,
    tier: "M",
    column,
    work: view.work,
  }) as StoryView;

/** The ux-spec's S2 scenario: DIPO-447 merging, DIPO-446 in review, six stories waiting. */
function floorScenario() {
  const base = golden();
  const usage = base.work[0]!.usage;
  const running = floorWork(base.work[0]!, 47, {
    phase: "merge",
    model: "opus-5.5",
    progress: { criteriaMet: 10, criteriaTotal: 10, loop: 1, loopCap: 8, reviewRound: 1 },
    usage: { ...usage, run: { ...usage.run, elapsedMs: 36 * 60_000 }, budgetShare: 0.28 },
  });
  const reviewing = floorWork(base.work[0]!, 46, {
    phase: "review",
    model: "opus-5.5",
    progress: { criteriaMet: 6, criteriaTotal: 8, loop: 1, loopCap: 8, reviewRound: 1 },
    usage: { ...usage, run: { ...usage.run, elapsedMs: 4 * 60_000 } },
  });
  const snapshot: OfficeSnapshot = {
    ...base,
    work: [running, reviewing],
    stories: [
      floorStory(
        running,
        "Run a planning session with Claude in a read-only box",
        "In Progress",
        "running",
      ),
      floorStory(reviewing, "Planning tools for workers", "In Review", "review"),
      ...[448, 449, 450, 451, 452, 453].map((n) => waiting(n, 447)),
    ],
    questions: [],
    gates: [],
  };
  const chain = {
    rows: [
      { levels: [level(447), level(448, 449), level(450), level(451)], parked: "DIPO-447" },
      { levels: [level(452), level(453)] },
    ],
    nodes: [],
  };
  return { snapshot, chain, output: new Map([[`${running.work.run}:worker`, "thinking 1.1s\n"]]) };
}

describe("the Floor", () => {
  it("matches the ux-spec's S2: cards, pipeline lines, health-free, budget bar and UP NEXT", async () => {
    const { snapshot, chain, output } = floorScenario();
    // The mock is 112 cells wide; the Frame leaves the last column of the terminal free.
    const view = await mount({
      columns: 113,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      output,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    view.session.active("software")?.options.onEvent({
      cursor: { stream: "software", seq: 90 },
      at: "2026-10-14T10:04:00.000Z",
      type: "office.summary",
      data: { ...goldenHello.offices[0], slots: 3 },
    } as Event);
    const frame = await view.ui.waitFor("When DIPO-447 merges");
    await view.ui.waitFor("1 of 3 slots");
    const shown = lines(view.ui.frame());
    const mock = mockRows("02-floor.txt");
    // The body: from the row under the first rule to the UP NEXT sentence.
    const from = shown.findIndex((line) => /^─+$/.test(line)) + 1;
    const to = shown.findIndex((line) => line.includes("When DIPO-447"));
    // The engine sends no review verdict yet, so the mock's `approved` is not drawn.
    const expected = mock
      .slice(
        mock.findIndex((row) => row.startsWith("───")) + 1,
        mock.findIndex((row) => row.includes("When DIPO-447")) + 1,
      )
      .map((row) => row.replace(" · review round 1 approved", " · review round 1"));
    expect(shown.slice(from, to + 1)).toEqual(expected);
    expect(frame).not.toContain("busy");
  });

  it("shows a story under RUNNING or IN REVIEW, never both", async () => {
    const { snapshot, chain } = floorScenario();
    const { running, review } = floorStories(storeState(snapshot));
    expect(running.map((item) => String(item.story.story))).toEqual(["DIPO-447"]);
    expect(review.map((item) => String(item.story.story))).toEqual(["DIPO-446"]);
    // The reviewer's session ends: the story stays under IN REVIEW, with no session.
    const idle = floorStories(storeState({ ...snapshot, work: [snapshot.work[0]!] }));
    expect(idle.running.map((item) => String(item.story.story))).toEqual(["DIPO-447"]);
    expect(idle.review.map((item) => [String(item.story.story), item.view === null])).toEqual([
      ["DIPO-446", true],
    ]);
    // No story is in both, whatever the sessions.
    for (const work of [snapshot.work, [], [snapshot.work[1]!]]) {
      const split = floorStories(storeState({ ...snapshot, work }));
      const all = [...split.running, ...split.review].map((item) => String(item.story.story));
      expect(new Set(all).size).toBe(all.length);
    }
    void chain;
  });

  it("shows a story in review with no session under IN REVIEW alone, with no worker line", async () => {
    const { snapshot, chain } = floorScenario();
    const view = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, { ...snapshot, work: [snapshot.work[0]!] }]]),
      chain,
    });
    mounted.push(view.ui);
    const frame = await view.ui.waitFor("no session");
    const shown = lines(frame);
    expect(shown.filter((line) => line.includes("DIPO-446"))).toHaveLength(1);
    expect(shown.findIndex((line) => line.includes("IN REVIEW"))).toBeLessThan(
      shown.findIndex((line) => line.includes("DIPO-446")),
    );
    expect(frame).toContain("no session · waits for its review, test or merge");
  });

  it("shows health only when it is stuck, looping or lost", async () => {
    for (const [health, shown] of [
      ["busy", false],
      ["quiet", false],
      ["stuck", true],
      ["looping", true],
      ["lost", true],
    ] as const) {
      const { snapshot, chain } = floorScenario();
      const work = snapshot.work.map((entry, i) => (i === 0 ? { ...entry, health } : entry));
      const view = await mount({
        columns: 112,
        rows: 30,
        snapshots: new Map([[OFFICES.dipsaus, { ...snapshot, work }]]),
        chain,
      });
      mounted.push(view.ui);
      const frame = await view.ui.waitFor("DIPO-447");
      const now = lines(frame).find((line) => line.includes("now merging")) ?? "";
      expect(/ · (stuck|looping|lost)/i.test(now)).toBe(shown);
      expect(now.includes("quiet")).toBe(false);
    }
  });

  it("says why nothing runs when the office is idle", async () => {
    const { ui } = await open(120, 30, idleSnapshot());
    const frame = ui.frame();
    expect(frame).toContain("RUNNING");
    expect(frame).toContain(
      "Nothing is running and nothing is Ready: DIPO-31 waits on DIPO-21, DIPO-33 is Refined (R15), DIPO-29 is parke",
    );
    expect(frame).toContain("Nothing waits on another story.");
  });

  it("names the Refined story's rule from the gateFailures field, not the message (DIPO-97)", async () => {
    const message = "ready DIPO-33 failed R15: 2 unknowns open";
    const field = await open(
      120,
      30,
      withRefined((view) => ({
        ...view,
        gateMessages: [message],
        gateFailures: [{ rule: "R20", message, text: "2 unknowns open" }],
      })),
    );
    expect(field.ui.frame()).toContain("DIPO-33 is Refined (R20)");

    const messageOnly = await open(
      120,
      30,
      withRefined((view) => {
        const { gateFailures: _, ...rest } = view;
        return { ...rest, gateMessages: [message] };
      }),
    );
    expect(messageOnly.ui.frame()).toContain("DIPO-33 is Refined, DIPO-29");
  });

  it("points at the queue when Ready stories wait and nothing runs", async () => {
    const base = golden();
    const { ui } = await open(120, 30, { ...base, work: [] });
    expect(ui.frame()).toContain("Nothing is running. Ready 2: 3 Queue, then R to run one.");
  });

  it("follows live output on the now line, and its age moves with the clock", async () => {
    const { ui, session, clock } = await open(120, 40, boardSnapshot());
    await ui.waitFor("building · Step 39: retries now stop at the cap in src/notice.ts. · 12s ago");
    session.storeOutput(outputEvent(8, RUN_21, "worker", 0, "[tool] Edit src/stream.ts\n"));
    await ui.waitFor("now building · [tool] Edit src/stream.ts");
    session.storeOutput(outputEvent(9, RUN_21, "worker", 26, "Streaming now works.\n"));
    await ui.waitFor("now building · Streaming now works.");
    // Verify output no longer leads: verify runs in the box at the end of build (0002).
    const run24 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";
    const stored = session.output.get(`${run24}:verify`)!.length;
    session.storeOutput(outputEvent(10, run24, "verify", stored, "PASS test/retry.test.ts\n"));
    const worker = session.output.get(`${run24}:worker`)!.length;
    session.storeOutput(outputEvent(11, run24, "worker", worker, "All checks pass.\n"));
    await ui.waitFor("now building · All checks pass. · 12s ago");
    expect(ui.frame()).not.toContain("PASS test/retry.test.ts");
    clock.advance(60_000);
    await ui.waitFor("now building · All checks pass. · 1m ago", 2_000);
  });

  it("reads the stored tails once when the office opens, not on every render", async () => {
    const { ui, session } = await open(120, 40, boardSnapshot());
    await ui.waitFor("building · Step 39");
    const reads = () => session.reads.filter((read) => read.name === "work.outputRange").length;
    const before = reads();
    // Three runs, their worker output each: a read to the end and at most one empty read after it.
    expect(before).toBeGreaterThanOrEqual(3);
    expect(before).toBeLessThanOrEqual(6);
    await ui.press("j");
    await ui.press("k");
    await Bun.sleep(150);
    expect(reads()).toBe(before);
  });

  it("keeps q q quit visible and no line wider than the terminal at every width", async () => {
    for (const columns of [120, 100, 80, 79, 70, 60]) {
      for (const rows of [30, 16]) {
        const { ui } = await open(columns, rows, boardSnapshot());
        const shown = lines(ui.frame());
        expect(shown.at(-1)).toContain("q q quit");
        expect(shown.length).toBeLessThanOrEqual(rows);
        for (const line of shown) expect(line.length).toBeLessThanOrEqual(columns);
        await ui.press("3");
        await ui.waitFor("READY");
        expect(ui.frame()).toContain("q q quit");
      }
    }
  });

  it("cuts the board to the height and keeps the selected card on screen", async () => {
    const { ui } = await open(120, 16, boardSnapshot());
    expect(lines(ui.frame()).length).toBeLessThanOrEqual(16);
    await ui.press("j");
    await ui.press("j");
    const frame = await ui.waitFor("▌ ● DIPO-19");
    expect(lines(frame).length).toBeLessThanOrEqual(16);
    expect(frame).toContain("q q quit");
  });

  it("follows a work event with a new view", async () => {
    const { ui, session } = await open(120, 40);
    const stream = session.active(STREAM);
    const before = golden().work[1]!;
    const view = { ...before, phase: "review", health: "busy" };
    stream?.options.onEvent({
      cursor: { stream: STREAM, seq: 8 },
      at: "2026-10-14T10:05:00.000Z",
      type: "work.phase",
      data: { work: view.work, phase: "review", progress: view.progress, view },
    } as never);
    await ui.waitFor("now reviewing ·");
  });
});

const KEY_28 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C28";
const RUN_28 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C28";

/** DIPO-28's one stored run: it ended two hours before the test clock (10:04). */
function record28(endedAt = "2026-10-14T08:04:00.000Z"): RunRecord {
  return {
    run: RUN_28,
    agents: ["agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C28"],
    role: "developer",
    tier: "L",
    model: "claude-haiku",
    startedAt: "2026-10-14T07:00:00.000Z",
    endedAt,
    outcome: "completed",
    usage: {
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheCreateTokens: 0,
      cacheReadTokens: 50_000,
      turns: 14,
      elapsedMs: 3_840_000,
      estimatedCost: 0.12,
    },
  } as RunRecord;
}

/** Selects DIPO-28 (In Review) from the top: the three running cards come first. */
async function selectReview(ui: {
  press(key: string): Promise<void>;
  waitFor(text: string): Promise<string>;
}) {
  for (let i = 0; i < 3; i++) await ui.press("j");
  return ui.waitFor("▌ ○ DIPO-28");
}

describe("opening any card (DIPO-81)", () => {
  it("j and k move over every card, running first, then in review", async () => {
    const { ui } = await open(120, 40, boardSnapshot());
    for (const [story, glyph] of [
      ["DIPO-24", "●"],
      ["DIPO-19", "●"],
      ["DIPO-28", "○"],
    ]) {
      await ui.press("j");
      await ui.waitFor(`▌ ${glyph} ${story}`);
    }
    await ui.press("j");
    expect(ui.frame()).toContain("▌ ○ DIPO-28");
    await ui.press("k");
    await ui.waitFor("▌ ● DIPO-19");
    expect(ui.frame()).not.toContain("▌ ● DIPO-21");
  });

  it("Enter on an In Review row opens its last run with the stored output; Esc goes back", async () => {
    const { ui, session } = await open(120, 30, boardSnapshot());
    session.runs.set(KEY_28, [record28()]);
    session.output.set(`${RUN_28}:worker`, "Reading the story.\n[tool] Edit src/queue.ts\nDone.\n");
    session.output.set(`${RUN_28}:verify`, "$ bun run verify\nall green\n");
    await selectReview(ui);
    await ui.press("enter");
    let frame = await ui.waitFor("│ Done.");
    const shown = lines(frame);
    expect(shown.slice(0, 7)).toEqual([
      HEADER,
      ROOMS,
      RULE,
      ` DIPO-28 Show the merge queue · developer · L · claude-haiku · ${RUN_28}`,
      " run ended · DIPO-28 is In Review",
      " run      ended 2h ago (completed)   │ output (worker) [w]orker* [v]erify [i] prompt",
      " role     developer                  │ Reading the story.",
    ]);
    expect(frame).toContain(" model    claude-haiku");
    expect(frame).toContain("│ Done.");
    expect(frame).toContain(" usage    in 12k out 3k");
    expect(shown.at(-1)).toBe(
      `w v i streams   ↑↓ PgUp PgDn scroll   End follow   z expand   c copy id${" ".repeat(29)}esc back   q q quit`,
    );
    expect(session.reads).toContainEqual({
      name: "story.detail",
      args: { office: OFFICES.dipsaus, story: KEY_28 },
    });
    await ui.press("v");
    frame = await ui.waitFor("│ all green");
    // p parks nothing from an ended run's detail.
    await ui.press("p");
    await ui.waitFor("this run has ended; park its story from the queue or the desk");
    expect(session.commands).toEqual([]);
    await ui.press("escape");
    frame = await ui.waitFor("IN REVIEW");
    expect(frame).toContain("▌ ○ DIPO-28 ");
  });

  it("says the output was removed after the retention period, or that none was stored", async () => {
    const old = await open(120, 30, boardSnapshot());
    old.session.runs.set(KEY_28, [record28("2026-10-05T08:00:00.000Z")]);
    await selectReview(old.ui);
    await old.ui.press("enter");
    let frame = await old.ui.waitFor("run ended · DIPO-28 is In Review");
    frame = await old.ui.waitFor("│ output removed after the retention period");

    const recent = await open(80, 30, boardSnapshot());
    recent.session.runs.set(KEY_28, [record28()]);
    await selectReview(recent.ui);
    await recent.ui.press("enter");
    frame = await recent.ui.waitFor(" no output stored");
    expect(frame).toContain(" run ended 2h ago (completed)  role developer");
    expect(lines(frame).at(-1)).toContain("q q quit");
  });

  it("shows a run open at In Review as at In Review, not as ended (DIPO-373)", async () => {
    const { endedAt, outcome: _, ...stored } = record28();
    const atReview = await open(80, 30, boardSnapshot());
    atReview.session.runs.set(KEY_28, [{ ...stored, inReviewSince: endedAt } as RunRecord]);
    await selectReview(atReview.ui);
    await atReview.ui.press("enter");
    const frame = await atReview.ui.waitFor(" run at In Review since 2h ago  role developer");
    expect(frame).toContain("run at In Review · DIPO-28 waits for its review, test or merge");
    expect(frame).not.toContain("run ended");
  });

  it("uses the office's retention period from its summary for the removed-output line (DIPO-97)", async () => {
    const hello = goldenHello.offices.find((entry) => entry.office === OFFICES.dipsaus);
    if (hello === undefined) throw new Error("no golden summary");
    const { outputRetentionDays: _, ...summary } = hello;
    const shows = async (days: number | undefined, endedAt: string, line: string) => {
      const { ui, session } = await open(120, 30, boardSnapshot());
      session.active("software")?.options.onEvent({
        cursor: { stream: "software", seq: 90 },
        at: "2026-10-14T10:04:00.000Z",
        type: "office.summary",
        data: days === undefined ? summary : { ...summary, outputRetentionDays: days },
      } as Event);
      session.runs.set(KEY_28, [record28(endedAt)]);
      await selectReview(ui);
      await ui.press("enter");
      await ui.waitFor("run ended · DIPO-28 is In Review");
      return ui.waitFor(`│ ${line}`);
    };
    // Nine days ago: removed under the golden 7 days (the test above), kept under 30.
    await shows(30, "2026-10-05T08:00:00.000Z", "no output stored");
    // Three days ago: removed under a 2-day period.
    await shows(2, "2026-10-11T08:00:00.000Z", "output removed after the retention period");
    // Without the period the TUI does not claim that output was removed.
    await shows(undefined, "2026-10-05T08:00:00.000Z", "no output stored");
  });

  it("keeps q q quit visible in an ended run's detail at every width", async () => {
    for (const columns of [120, 80, 70, 60]) {
      const { ui, session } = await open(columns, 24, boardSnapshot());
      session.runs.set(KEY_28, [record28()]);
      await selectReview(ui);
      await ui.press("enter");
      const frame = await ui.waitFor("run ended");
      const shown = lines(frame);
      expect(shown.at(-1)).toContain("q q quit");
      expect(shown.length).toBeLessThanOrEqual(24);
      for (const line of shown) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps the privacy words off the Floor and its header: they live in the settings (DIPO-458)", async () => {
    const { ui, session } = await open(120);
    const summary = goldenHello.offices.find((entry) => entry.office === OFFICES.dipsaus);
    session.active("software")?.options.onEvent({
      cursor: { stream: "software", seq: 90 },
      at: "2026-10-14T10:04:00.000Z",
      type: "office.summary",
      data: { ...summary, optIns: ["privacy.storeCommandBodies"], ready: 7 },
    } as Event);
    // The summary arrived: the Queue room counts its Ready stories.
    const frame = await ui.waitFor("3 Queue 7");
    expect(frame).not.toContain("stores");
    expect(frame).not.toContain("privacy");
  });
});

describe("usage in the switcher (DIPO-311)", () => {
  const NOW = Date.UTC(2026, 9, 22, 14);
  const office = OFFICES.dipsaus;
  const base = {
    office,
    name: "o",
    path: "/o",
    running: 0,
    parked: 0,
    waitingOnMaintainer: 0,
  };

  it("keeps the ALERT wording on Offices' TODAY bar, in err", () => {
    const entry = {
      name: "o",
      office,
      summary: { ...base, dayUsage: { tokens: 9, limit: 10, share: 0.9, alert: true } },
    };
    const cells = officeCells(entry as never, false, NOW, false);
    expect(cells.share).toBe("90% ALERT");
    expect(cells.alert).toBe(true);
    expect(cells.filled).toBe(11);
  });
});
