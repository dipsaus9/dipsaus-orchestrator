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
  TestView,
  WorkView,
} from "@dipsaus-orchestrator/contract";

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import { floorStories } from "./overview";
import { goldenHello, goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { expectScreen } from "../test/support/mock-screens";
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
const ROOMS = expect.stringMatching(/^1 Desk .*6 Roles$/) as unknown as string;
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
    // The planning lane has two changes open and the backlog PR #656 runs its CI (DIPO-481).
    lane: {
      ops: [
        {
          op: 7,
          what: "an accepted idea filed as a draft",
          subject: "idea 4f2a9c1e",
          state: "queued",
          since: "2026-10-14T10:00:00.000Z",
        },
        {
          op: 8,
          what: "a confirmed story filed",
          subject: "DIPO-488",
          state: "pr",
          since: "2026-10-14T09:58:00.000Z",
        },
      ],
      pr: {
        number: 656,
        url: "https://github.com/acme/widgets/pull/656",
        ci: "running",
        autoMerge: true,
        merged: false,
      },
    },
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

/** DIPO-506's open test, the one the TEST row names. */
const testView = {
  test: "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0T06",
  story: "DIPO-506",
  key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C06",
  checkout: "dipo-tst_01J9ZK5Q8W3V4X6Y7Z8A9B0T06",
  head: "8a1e2f0c2e4f6a8b0d1c3e5f7a9b1d3f5a7c9e1b",
  steps: [{ check: "Press o", expect: "The office switcher opens" }, { check: "Type slay" }],
  startedAt: "2026-10-14T09:58:00.000Z",
} as TestView;

/** An ISO time on the test clock's day (UTC, as the test clock runs). */
const at = (hhmm: string) => `2026-10-14T${hhmm}:00.000Z`;

/** The mock 03-floor-background.txt's scenario: DIPO-519 building, DIPO-518 waits, five background items. */
function backgroundScenario() {
  const { snapshot: floor } = floorScenario();
  const base = golden();
  const usage = base.work[0]!.usage;
  const running = floorWork(base.work[0]!, 19, {
    phase: "build",
    model: "sonnet-5.5",
    progress: { criteriaMet: 0, criteriaTotal: 5, loop: 1, loopCap: 5, reviewRound: 0 },
    usage: { ...usage, run: { ...usage.run, elapsedMs: 14 * 60_000 }, budgetShare: 0.19 },
  });
  const work = { ...running, work: { ...running.work, story: "DIPO-519" } } as WorkView;
  const background = [
    {
      kind: "story-pr",
      ref: "PR #698",
      subject: "DIPO-512 · CI failed: test (bun 1.4) · attempt 2 of 3",
      state: "failed",
      ci: "failed",
      next: "retries at 10:35; after attempt 3 it goes to your Desk",
      since: at("10:30"),
    },
    {
      kind: "backlog-pr",
      ref: "PR #702",
      subject: "backlog PR · 3 changes · CI running",
      state: "running",
      ci: "running",
      next: "auto-merges when green",
      since: at("10:28"),
    },
    {
      kind: "test",
      ref: testView.test,
      subject: "DIPO-506 at 8a1e2f0 · box up · step 2 of 4",
      state: "waiting",
      next: "waits on you since 09:58",
      since: at("09:58"),
    },
    {
      kind: "audit",
      ref: "audit",
      subject: "3 ideas from DIPO-509",
      state: "running",
      next: "audit running since 10:19",
      since: at("10:19"),
    },
    {
      kind: "daemon",
      ref: "update",
      subject: "dipo built f07dd11 and restarted",
      state: "done",
      since: at("10:24"),
    },
  ] as OfficeSnapshot["background"];
  const snapshot: OfficeSnapshot = {
    ...floor,
    work: [work],
    stories: [
      floorStory(
        work,
        "Write proposed decision 0023 on granting skills and plugins",
        "In Progress",
        "running",
      ),
      waiting(518, 519),
    ],
    background,
    tests: [testView],
  };
  const { lane } = floor;
  const withLane = { ...snapshot, ...(lane === undefined ? {} : { lane }) };
  const chain = { rows: [{ levels: [level(519), level(518)] }], nodes: [] };
  return {
    snapshot: withLane,
    chain,
    output: new Map([[`${work.work.run}:worker`, "thinking 2.1s\n"]]),
  };
}

/** A `background.changed` event of the office stream at `hhmm` on the test clock's day. */
function changed(
  view: Awaited<ReturnType<typeof mount>>,
  seq: number,
  hhmm: string,
  line: string,
  state = "running",
  item: object = { kind: "story-pr", ref: `PR #${seq}`, subject: line, state, since: at(hhmm) },
) {
  view.session.active(STREAM)?.options.onEvent({
    cursor: { stream: STREAM, seq: 5_000 + seq },
    at: at(hhmm),
    type: "background.changed",
    data: {
      item,
      line,
    },
  } as Event);
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
    expectScreen(view.ui, "02-floor.txt");
    expect(frame).not.toContain("busy");
  });

  it("matches the mock of the BACKGROUND group, its header chip and its ticker (DIPO-528)", async () => {
    const { snapshot, chain, output } = backgroundScenario();
    const view = await mount({
      columns: 113,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      output,
      now: Date.parse(at("10:31")),
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    // The open office has three slots and spent $5.12; no other office needs you.
    const summary = (seq: number, data: object) =>
      view.session.active("software")?.options.onEvent({
        cursor: { stream: "software", seq },
        at: at("10:31"),
        type: "office.summary",
        data,
      } as Event);
    summary(90, {
      ...goldenHello.offices[0],
      slots: 3,
      dayUsage: { tokens: 1200, alert: false, estimatedCost: 5.12 },
    });
    summary(91, {
      office: OFFICES.slaydoku,
      name: "slaydoku",
      path: "/work/slaydoku",
      running: 0,
      parked: 0,
      waitingOnMaintainer: 0,
      ready: 0,
    });
    await view.ui.waitFor("1 of 3 slots");
    // The failed PR is the focused row.
    await view.ui.press("j");
    // Changes that leave the listed items as they are: only the ticker shows them.
    const [failed, backlog, , , update] = snapshot.background!;
    changed(view, 1, "10:24", "dipo restarted on f07dd11", "done", update);
    changed(view, 2, "10:28", "backlog PR #702 opened", "running", backlog);
    changed(view, 3, "10:30", "PR #698 CI failed (test, bun 1.4)", "failed", failed);
    await view.ui.waitFor("10:30 PR #698 CI failed");
    expectScreen(view.ui, "03-floor-background.txt");
  });

  it("opens a story PR at its level and matches the mock of its checks (DIPO-528)", async () => {
    const { snapshot, chain } = backgroundScenario();
    const line = (hhmm: string | undefined, ...spans: [string, ("err" | "dim")?][]) => ({
      ...(hhmm === undefined ? {} : { at: at(hhmm) }),
      spans: spans.map(([text, tone]) => ({ text, ...(tone === undefined ? {} : { tone }) })),
    });
    const [failed, ...rest] = snapshot.background!;
    const detailed = {
      ...failed!,
      detail: {
        status: "attempt 2 of 3 · retries at 10:35",
        next: ["retries at 10:35", "then on your Desk"],
        note: "Failed on bun 1.4 in both attempts and passed on bun 1.5.",
        checks: [
          { name: "format", state: "passed", log: [] },
          { name: "lint", state: "passed", log: [] },
          { name: "typecheck", state: "passed", log: [] },
          {
            name: "test (bun 1.4)",
            state: "failed",
            at: at("10:30"),
            seconds: 192,
            log: [
              line("10:30", ["bun test packages/daemon"]),
              line(
                "10:30",
                ["✗", "err"],
                [" lock survives restart  "],
                ["packages/daemon/test/lock.test.ts:88", "dim"],
              ),
              line(undefined, ["expected pid 4121 to equal 4377"]),
              line(undefined, ["at reacquire  "], ["packages/daemon/src/lock.ts:142", "dim"]),
              line("10:30", ["412 pass · "], ["1 fail", "err"]),
            ],
          },
          { name: "test (bun 1.5)", state: "passed", log: [] },
        ],
      },
    };
    const stories = [
      ...snapshot.stories,
      {
        ...waiting(512, 519),
        title: "Keep the daemon's lock across a restart",
      },
    ];
    const view = await mount({
      columns: 113,
      rows: 30,
      snapshots: new Map([
        [
          OFFICES.dipsaus,
          { ...snapshot, stories, background: [detailed, ...rest] } as OfficeSnapshot,
        ],
      ]),
      chain,
      now: Date.parse(at("10:32")),
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.waitFor("BACKGROUND");
    await view.ui.press("j");
    await view.ui.press("enter");
    await view.ui.waitFor("CHECKS");
    const [, backlog, , , update] = snapshot.background!;
    changed(view, 1, "10:24", "dipo restarted on f07dd11", "done", update);
    changed(view, 3, "10:30", "PR #698 CI failed (test, bun 1.4)", "failed", detailed);
    await view.ui.waitFor("10:30 PR #698 CI failed");
    expectScreen(view.ui, "04-background-detail.txt");
    void backlog;
    await view.ui.press("escape");
    await view.ui.waitFor("BACKGROUND");
  });

  it("lists BACKGROUND from the snapshot in its order, after UP NEXT, and no group without items (DIPO-528)", async () => {
    const { snapshot, chain } = backgroundScenario();
    const view = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
    });
    mounted.push(view.ui);
    const shown = lines(await view.ui.waitFor("BACKGROUND"));
    expect(shown.some((line) => line.includes("BACKLOG"))).toBe(false);
    const rows = shown.filter((line) => /^[▌ ] [✗!◌○✓] /.test(line) && line.includes("PR #"));
    expect(rows.map((line) => line.slice(4, 14).trim())).toEqual(["PR #698", "PR #702"]);
    expect(shown.findIndex((line) => line.includes("UP NEXT"))).toBeLessThan(
      shown.findIndex((line) => line.includes("BACKGROUND")),
    );
    const { background: _background, ...quiet } = snapshot;
    const without = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, quiet]]),
      chain,
    });
    mounted.push(without.ui);
    await without.ui.waitFor("When DIPO-519 merges");
    expect(without.ui.frame()).not.toContain("BACKGROUND");
  });

  it("lists the lane's open changes with Enter on the backlog PR, and hides them with Enter again (DIPO-481, DIPO-528)", async () => {
    const { snapshot, chain } = backgroundScenario();
    const view = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("BACKGROUND");
    // The story card is the first stop, the failed PR the second and the backlog PR the third.
    for (let i = 0; i < 2; i++) await view.ui.press("j");
    await view.ui.waitFor("▌ ◌ PR #702");
    await view.ui.press("enter");
    const frame = await view.ui.waitFor("a confirmed story filed");
    expect(frame).toContain("an accepted idea filed as a draft · idea 4f2a9c1e · queued");
    expect(frame).toContain("a confirmed story filed · DIPO-488 · in the PR");
    expect(frame).toContain("⏎ hide");
    await view.ui.press("enter");
    await Bun.sleep(50);
    expect(view.ui.frame()).not.toContain("a confirmed story filed");
  });

  it("opens a test's checklist with t on its row (DIPO-528)", async () => {
    const { snapshot, chain } = backgroundScenario();
    const view = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("BACKGROUND");
    for (let i = 0; i < 3; i++) await view.ui.press("j");
    await view.ui.waitFor("▌ ○ TEST");
    await view.ui.press("t");
    // The checklist of the open test, as the Desk's `t` shows it, or its absence in words.
    const frame = await view.ui.waitFor("test");
    expect(frame).not.toContain("▌ ○ TEST");
  });

  it("shows a background change in the ticker with its HH:MM, newest first (DIPO-528)", async () => {
    const { snapshot, chain } = backgroundScenario();
    const view = await mount({
      columns: 112,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("BACKGROUND");
    changed(view, 91, "10:24", "dipo restarted on f07dd11");
    changed(view, 92, "10:30", "PR #698 CI failed (test, bun 1.4)");
    const frame = await view.ui.waitFor("10:30 PR #698 CI failed");
    expect(frame).toContain(
      "10:30 PR #698 CI failed (test, bun 1.4)  ·  10:24 dipo restarted on f07dd11",
    );
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
    let frame = await ui.waitFor("Done.");
    const shown = lines(frame);
    expect(shown.slice(0, 8)).toEqual([
      HEADER,
      ROOMS,
      RULE,
      `DIPO-28 Show the merge queue · developer · L · claude-haiku · ${RUN_28}`,
      RULE,
      " run ended · DIPO-28 is In Review",
      expect.stringMatching(/^run      ended 2h ago \(completed\)   │ +all   worker/),
      expect.stringMatching(/^role     developer                  │ +says +Reading the story\./),
    ]);
    expect(frame).toContain("model    claude-haiku");
    expect(frame).toContain("usage    in 12k out 3k");
    expect(shown.at(-1)).toBe(
      `v stream   ↑↓ scroll   G follow   z expand   c copy id${" ".repeat(46)}esc back   q q quit`,
    );
    expect(session.reads).toContainEqual({
      name: "story.detail",
      args: { office: OFFICES.dipsaus, story: KEY_28 },
    });
    await ui.press("v");
    await ui.press("v");
    await ui.press("v");
    frame = await ui.waitFor("all green");
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
    frame = await old.ui.waitFor("output removed after the retention period");

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
      return ui.waitFor(line);
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
