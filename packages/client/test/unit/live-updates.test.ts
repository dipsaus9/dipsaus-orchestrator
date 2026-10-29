// Live updates from other clients (DIPO-322): two real `DipoClient`s against the daemon in memory.
// The store of the first (the TUI's) follows an office while the second (the CLI of another
// terminal) starts, moves and ends a run; every `work.assigned`, `work.phase`, `work.progress`,
// `work.output` and `story.state` it caused changes the store without a new snapshot. After a
// daemon restart the client reconnects while the daemon still recovers, which refuses the office
// subscription with `engine.recovering`; the store subscribes again after its last cursor and
// keeps following. Before DIPO-322 it kept that refusal as its error and never subscribed again,
// so an open view stayed frozen until the office was opened again. A failed office switch leaves
// the current office's stream in force.

import { describe, expect, it } from "bun:test";

import {
  type OfficeId,
  type RunId,
  StoryView,
  WorkView,
  workRun,
  storyPark,
} from "@dipsaus-orchestrator/contract";
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
  return { criteriaMet, criteriaTotal: 3, loop: 1, loopCap: 3, verify: "none", reviewRound: 0 };
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

  it("subscribes again in safe mode, where office streams are served", async () => {
    const { clock, daemon, store } = await setup();
    daemon.stop();
    await flush();
    daemon.start();
    clock.advance(RECONNECT_INITIAL_MS);
    await flush();
    daemon.setState("safe");
    await flush();
    expect(store.state.live).toBe(true);
    daemon.write(STARTED);
    await flush();
    expect(shown(store).run).toBe("setup 0/3");
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
