// Live updates from other clients (DIPO-322): two real `DipoClient`s against the daemon in memory.
// The store of the first (the TUI's) follows an office while the second (the CLI of another
// terminal) starts, moves and ends a run; every `work.assigned`, `work.phase`, `work.progress`,
// `work.output` and `story.state` it caused changes the store without a new snapshot. After a
// daemon restart the client reconnects while the daemon still recovers, which refuses the office
// subscription with `engine.recovering`; the store subscribes again after its last cursor and
// keeps following. Before DIPO-322 it kept that refusal as its error and never subscribed again,
// so an open view stayed frozen until the office was opened again. A failed office switch leaves
// the current office's stream in force.
//
// A run that ends through a merge after the maintainer's test pass (DIPO-421) leaves `work` on its
// `run.ended`; the engine's `ended done` marker in the same write carries no view. Before DIPO-421
// the store applied no `run.ended` and the marker carried a view of the ended run, which the store
// put, so the open TUI listed the run under RUNNING until the story's `story.state` to Done.

import { describe, expect, it } from "bun:test";

import {
  type EventDefinition,
  engineNotice,
  gateDecided,
  gateReached,
  type OfficeId,
  type RunId,
  runEnded,
  StoryView,
  storyPr,
  storyState,
  testRecorded,
  testStarted,
  WorkView,
  workAssigned,
  workOutput,
  workPhase,
  workRun,
  storyPark,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  DipoClient,
  OfficeStore,
  type OutputChunk,
  RECONNECT_INITIAL_MS,
  RECOVERY_POLL_MS,
} from "../../src/index";
import { FakeDaemon, type Write } from "./fake-daemon";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA" as OfficeId;
const OTHER = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CBB" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C01" as RunId;
const AT = "2026-10-23T10:00:00.000Z";
const CLIENT = { name: "live-test", version: "0" };

const REF = {
  story: "DIPO-1",
  key: KEY,
  run: RUN,
  agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C01",
  role: "developer",
  tier: "M",
  model: "claude-sonnet",
};

function story(lifecycle: "Ready" | "In Progress" | "In Review", running: boolean): StoryView {
  return StoryView.parse({
    key: KEY,
    story: "DIPO-1",
    provisional: false,
    title: "Story DIPO-1",
    lifecycle,
    tier: "M",
    column: running ? "running" : lifecycle === "Ready" ? "ready" : "review",
    ...(running ? { work: REF } : {}),
  });
}

function progress(criteriaMet: number) {
  return {
    criteriaMet,
    criteriaTotal: 3,
    loop: 1,
    loopCap: 3,
    verify: "none" as const,
    reviewRound: 0,
  };
}

function view(phase: string, criteriaMet: number): WorkView {
  const totals = {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    turns: 1,
    elapsedMs: 1,
  };
  return WorkView.parse({
    work: REF,
    phase,
    progress: progress(criteriaMet),
    usage: {
      agent: totals,
      run: totals,
      budget: { unit: "tokens", limit: 100, used: 2 },
      budgetShare: 0.02,
    },
    health: "busy",
    startedAt: AT,
  });
}

/** What `work.run` of DIPO-1 writes: the run is assigned, set up and the story is In Progress. */
const STARTED: Write = [
  { type: "work.assigned", data: { work: REF, view: view("setup", 0) } },
  {
    type: "work.phase",
    data: { work: REF, phase: "setup", progress: progress(0), view: view("setup", 0) },
  },
  {
    type: "story.state",
    data: {
      story: "DIPO-1",
      key: KEY,
      from: "Ready",
      to: "In Progress",
      view: story("In Progress", true),
    },
  },
];

/** The worker moves on: build, a criterion met, a line of output. */
const MOVED: Write = [
  {
    type: "work.phase",
    data: { work: REF, phase: "build", progress: progress(0), view: view("build", 0) },
  },
  { type: "work.progress", data: { work: REF, progress: progress(1), view: view("build", 1) } },
  {
    type: "work.output",
    data: { work: REF, source: "worker", from: 0, to: 6, text: "hello\n", view: view("build", 1) },
  },
];

/** The run ends: the story goes to In Review without it. */
const ENDED: Write = [
  {
    type: "story.state",
    data: {
      story: "DIPO-1",
      key: KEY,
      from: "In Progress",
      to: "In Review",
      view: story("In Review", false),
    },
  },
];

/** Lets every queued frame and promise callback run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function connected(daemon: FakeDaemon, clock: ManualClock, origin: "tui" | "cli") {
  const client = new DipoClient({ transport: daemon, clock, client: CLIENT, origin });
  const connecting = client.connect();
  await flush();
  await connecting;
  return client;
}

async function setup() {
  const clock = new ManualClock();
  const daemon = new FakeDaemon(OFFICE, [story("Ready", false)]);
  daemon.onCommand = (name) => {
    if (name === workRun.name) {
      return {
        write: STARTED,
        result: { started: [{ story: "DIPO-1", key: KEY, run: RUN }], skipped: [] },
      };
    }
    return { write: ENDED, result: { story: "DIPO-1", key: KEY, run: RUN } };
  };
  const tui = await connected(daemon, clock, "tui");
  const store = new OfficeStore({ client: tui, clock, clientInfo: CLIENT });
  store.start();
  const opened = store.open(OFFICE);
  await flush();
  expect((await opened).ok).toBe(true);
  await flush();
  expect(store.state.live).toBe(true);
  const output: OutputChunk[] = [];
  store.onOutput((chunk) => output.push(chunk));
  const cli = await connected(daemon, clock, "cli");
  return { clock, daemon, tui, store, cli, output };
}

/** The views the TUI draws from the store: the story's column and the run's phase and criteria. */
function shown(store: OfficeStore) {
  const run = store.state.work.find((work) => work.work.run === RUN);
  const shownStory = store.state.stories.find((candidate) => candidate.key === KEY);
  return {
    lifecycle: shownStory?.lifecycle,
    column: shownStory?.column,
    run: run === undefined ? null : `${run.phase} ${run.progress.criteriaMet}/3`,
  };
}

describe("an office store follows runs another client starts, moves and ends", () => {
  it("applies work.assigned, work.phase, work.progress, work.output and story.state without a new snapshot", async () => {
    const { store, cli, daemon, output } = await setup();
    const snapshots = store.state.snapshots;

    const started = await cli.command(workRun, { stories: ["DIPO-1"] }, { office: OFFICE });
    expect(started.ok).toBe(true);
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Progress", column: "running", run: "setup 0/3" });

    // dipo itself moves the run: the worker builds, meets a criterion and writes a line.
    daemon.write(MOVED);
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Progress", column: "running", run: "build 1/3" });
    expect(output).toEqual([{ run: RUN, source: "worker", from: 0, to: 6, text: "hello\n" }]);

    await cli.command(storyPark, { story: "DIPO-1", note: "later" }, { office: OFFICE });
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Review", column: "review", run: null });
    expect(store.state.cursor).toEqual(daemon.officeHead);
    expect(store.state.snapshots).toBe(snapshots);
  });
});

describe("after a daemon restart", () => {
  it("reconnects, subscribes again after its last cursor once the daemon recovered, and keeps updating", async () => {
    const { clock, daemon, store, cli } = await setup();
    await cli.command(workRun, { stories: ["DIPO-1"] }, { office: OFFICE });
    await flush();
    const last = store.state.cursor!;
    expect(last).toEqual(daemon.officeHead);

    // A new build: the daemon stops and starts again, still recovering its offices.
    daemon.stop();
    await flush();
    expect(store.state.connection).toBe("reconnecting");
    daemon.start();
    clock.advance(RECONNECT_INITIAL_MS);
    await flush();
    expect(store.state.connection).toBe("open");
    expect(store.state.daemon).toBe("recovering");
    // The client sent its office subscription again after the last cursor; the daemon refused it.
    expect(daemon.subscribes.filter((s) => s.stream === `office:${OFFICE}`).at(-1)).toEqual({
      stream: `office:${OFFICE}`,
      after: last,
      answer: "engine.recovering",
    });
    expect(store.state.live).toBe(false);
    expect(store.state.error?.code).toBe("engine.recovering");

    // Still recovering: the store asks again every RECOVERY_POLL_MS without re-rendering.
    let renders = 0;
    const stop = store.subscribe(() => {
      renders += 1;
    });
    clock.advance(RECOVERY_POLL_MS);
    await flush();
    expect(daemon.subscribes.filter((s) => s.answer === "engine.recovering")).toHaveLength(2);
    expect(renders).toBe(0);
    stop();

    // The daemon recovered: `daemon.state` on the software stream resubscribes at once.
    daemon.setState("running");
    await flush();
    expect(daemon.subscribes.at(-1)).toEqual({
      stream: `office:${OFFICE}`,
      after: last,
      answer: "ok",
    });
    expect(store.state.live).toBe(true);
    expect(store.state.error).toBeNull();

    // The other client's CLI reconnected too; it ends the run and the open view follows.
    expect(cli.state).toBe("open");
    await cli.command(storyPark, { story: "DIPO-1", note: "later" }, { office: OFFICE });
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Review", column: "review", run: null });
    expect(store.state.cursor).toEqual(daemon.officeHead);
    expect(store.state.snapshots).toBe(1);
  });

  it("replays what was stored while the daemon still recovered, without a new snapshot", async () => {
    const { clock, daemon, store } = await setup();
    daemon.stop();
    await flush();
    daemon.start();
    clock.advance(RECONNECT_INITIAL_MS);
    await flush();
    expect(store.state.error?.code).toBe("engine.recovering");

    // Recovery itself writes facts (reconcile, a resumed run) before the daemon serves offices.
    daemon.write(STARTED);
    daemon.write(MOVED);
    daemon.state = "running";
    clock.advance(RECOVERY_POLL_MS);
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Progress", column: "running", run: "build 1/3" });
    expect(store.state.live).toBe(true);
    expect(store.state.snapshots).toBe(1);
  });

  it("does not subscribe again to an office the maintainer left", async () => {
    const { clock, daemon, store } = await setup();
    daemon.stop();
    await flush();
    daemon.start();
    clock.advance(RECONNECT_INITIAL_MS);
    await flush();
    store.close();
    const before = daemon.subscribes.length;
    daemon.setState("running");
    clock.advance(RECOVERY_POLL_MS * 4);
    await flush();
    expect(daemon.subscribes.length).toBe(before);
  });
});

describe("a failed office switch", () => {
  it("keeps following the current office", async () => {
    const { store, cli } = await setup();
    const outcome = store.switchTo(OTHER);
    await flush();
    expect((await outcome).ok).toBe(false);
    expect(store.state.office).toBe(OFFICE);

    await cli.command(workRun, { stories: ["DIPO-1"] }, { office: OFFICE });
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Progress", column: "running", run: "setup 0/3" });
  });
});

/** One stored entry, its data checked against the engine's event definition in the contract. */
function entry<D extends z.ZodType>(definition: EventDefinition<string, D>, data: z.input<D>) {
  return { type: definition.type, data: definition.data.parse(data) };
}

/** The reviewer session of DIPO-1's run that the test and the merge gate wait in. */
const REVIEWER = { ...REF, agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C02", role: "reviewer", tier: "S" };

function reviewerView(phase: string): WorkView {
  return WorkView.parse({ ...view(phase, 3), work: REVIEWER, health: "busy" });
}

const TEST = "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0T01";
const TEST_GATE = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G01";
const MERGE_GATE = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G02";
const HEAD = "9f8e7d6c5b4a32109f8e7d6c5b4a32109f8e7d6c";
const PR = { number: 36, url: "https://github.com/example/scratch/pull/36" };

/** `marker`'s line at `[from, to)` of the worker output, as the engine writes it (`ended done`). */
function marker(kind: "phase" | "ended", value: string, from: number) {
  const text = `[dipo] ${AT} ${kind} ${value}\n`;
  const to = from + text.length;
  return { text, from, to, markers: [{ from, to, kind, value, at: AT }] };
}

/**
 * DIPO-1 flagged test-before-merge, reviewed: the run enters phase `test` and its merge gate
 * waits for the maintainer (`openMergeGate`), and `test.start` opens the test.
 */
const IN_TEST: Write = [
  entry(workAssigned, { work: REVIEWER, view: reviewerView("review") }),
  entry(workOutput, {
    work: REVIEWER,
    source: "worker",
    ...marker("phase", "test", 0),
    view: reviewerView("test"),
  }),
  entry(workPhase, {
    work: REVIEWER,
    phase: "test",
    progress: progress(3),
    view: reviewerView("test"),
  }),
  entry(gateReached, {
    gate: MERGE_GATE,
    work: REVIEWER,
    kind: "merge",
    waitingOn: "maintainer",
    summary: "DIPO-1 waits for the maintainer's test before it merges",
  }),
  entry(testStarted, {
    test: TEST,
    story: "DIPO-1",
    key: KEY,
    checkout: "dipo-test-1",
    head: HEAD,
    steps: [{ check: "run the product" }],
    shell: "dipo test shell DIPO-1",
    startedAt: AT,
  }),
];

/**
 * `test.record` pass (`recordTestResult`): the test gate is reached and decided, the merge gate
 * the pass answers is decided by the maintainer, and the test is recorded.
 */
const TEST_PASSED: Write = [
  entry(gateReached, {
    gate: TEST_GATE,
    work: REVIEWER,
    kind: "test",
    waitingOn: "maintainer",
    summary: "DIPO-1: the maintainer's test of 9f8e7d6c5b4a passed",
  }),
  entry(gateDecided, { gate: TEST_GATE, decision: "approved", by: "maintainer" }),
  entry(gateDecided, {
    gate: MERGE_GATE,
    decision: "approved",
    by: "maintainer",
    note: `test ${TEST} passed`,
  }),
  entry(testRecorded, { test: TEST, story: "DIPO-1", key: KEY, result: "pass" }),
];

/** The auto-merge poll: the story PR, then GitHub merged it. */
const MERGED: Write = [
  entry(storyPr, { story: "DIPO-1", key: KEY, pr: { ...PR, state: "open" } }),
  entry(storyPr, { story: "DIPO-1", key: KEY, pr: { ...PR, state: "merged" } }),
];

/**
 * The Done poll's teardown (`tearDown`, `releaseClaim`, `endRunMarked`): the claim is released and
 * the run ends done, with its `ended done` marker, whose `work.output` carries no view since the run
 * ended, then the teardown notice. The story stays In Review until the story index reads Done on
 * the base.
 */
const TORN_DOWN: Write = [
  entry(runEnded, {
    run: RUN,
    kind: "story",
    ending: "done",
    endedAt: AT,
    key: KEY,
    story: "DIPO-1",
  }),
  entry(workOutput, {
    work: REVIEWER,
    source: "worker",
    ...marker("ended", "done", marker("phase", "test", 0).to),
  }),
  entry(engineNotice, {
    level: "info",
    code: "teardown.done",
    text: `DIPO-1 is Done: its PR #36 merged (${PR.url}). dipo deleted the branch DIPO-1/story.`,
  }),
];

/** Later: the story index reads Done on the base. */
const DONE: Write = [
  entry(storyState, {
    story: "DIPO-1",
    key: KEY,
    from: "In Review",
    to: "Done",
    view: StoryView.parse({ ...story("In Review", false), lifecycle: "Done", column: "done" }),
  }),
];

describe("a run that ends through a merge after a test pass", () => {
  it("leaves work on its run.ended, before the story turns Done, as a store opened then shows", async () => {
    const clock = new ManualClock();
    const daemon = new FakeDaemon(OFFICE, [story("In Review", false)]);
    const tui = await connected(daemon, clock, "tui");
    const store = new OfficeStore({ client: tui, clock, clientInfo: CLIENT });
    store.start();
    await store.open(OFFICE);
    await flush();
    const output: OutputChunk[] = [];
    store.onOutput((chunk) => output.push(chunk));

    daemon.write(IN_TEST);
    await flush();
    expect(shown(store).run).toBe("test 3/3");
    expect(store.state.tests.map((test) => String(test.test))).toEqual([TEST]);

    daemon.write(TEST_PASSED);
    daemon.write(MERGED);
    await flush();
    // Still in phase test: nothing that ends the run came yet.
    expect(shown(store).run).toBe("test 3/3");
    expect(store.state.gates).toEqual([]);
    expect(store.state.tests).toEqual([]);

    daemon.write(TORN_DOWN);
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "In Review", column: "review", run: null });
    expect(store.state.work).toEqual([]);
    expect(store.state.cursor).toEqual(daemon.officeHead);
    // The marker still reaches an open output pane, so the detail shows how the run ended.
    expect(output.at(-1)?.text).toBe(`[dipo] ${AT} ended done\n`);

    // A TUI opened now shows the same: no run.
    const fresh = await connected(daemon, clock, "tui");
    const other = new OfficeStore({ client: fresh, clock, clientInfo: CLIENT });
    other.start();
    await other.open(OFFICE);
    await flush();
    expect(other.state.work).toEqual([]);
    other.close();

    daemon.write(DONE);
    await flush();
    expect(shown(store)).toEqual({ lifecycle: "Done", column: "done", run: null });
    expect(store.state.snapshots).toBe(1);
  });

  it("shows a parked run again once its resume reopens it, as a fresh snapshot does", async () => {
    const clock = new ManualClock();
    const daemon = new FakeDaemon(OFFICE, [story("In Review", false)]);
    const tui = await connected(daemon, clock, "tui");
    const store = new OfficeStore({ client: tui, clock, clientInfo: CLIENT });
    store.start();
    await store.open(OFFICE);
    await flush();
    daemon.write(IN_TEST);
    daemon.write([
      entry(runEnded, { run: RUN, kind: "story", ending: "parked", endedAt: AT, key: KEY }),
    ]);
    await flush();
    expect(store.state.work).toEqual([]);

    // The resume reopens the run into a review that waits for the reviewer place (`reopen`): its
    // `review` marker carries the view again, before any reviewer session starts.
    daemon.write([
      entry(workOutput, {
        work: REVIEWER,
        source: "worker",
        ...marker("phase", "review", 100),
        view: reviewerView("review"),
      }),
    ]);
    await flush();
    expect(shown(store).run).toBe("review 3/3");
    const fresh = await connected(daemon, clock, "tui");
    const other = new OfficeStore({ client: fresh, clock, clientInfo: CLIENT });
    other.start();
    await other.open(OFFICE);
    await flush();
    expect(other.state.work.map((work) => work.phase)).toEqual(["review"]);
    other.close();
  });
});
