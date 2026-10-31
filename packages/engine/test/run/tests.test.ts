// Testing a story (DIPO-309, 0002): `test.start` refuses what cannot be tested, runs the pushed
// head in a test box (a fake box port here) and replies with the steps, URL, box name, shell line
// and test id; `test.record` decides the story's test gate for the head, lets a pass decide a merge
// gate waiting only on the flag, refuses an older head, and sends a fail's note to the same builder
// once; the sweep closes a test on a new head, a released claim, the story leaving review and the
// idle timeout, read on a manual clock; recovery takes open tests up again or closes them.

import { afterEach, describe, expect, it } from "bun:test";

import {
  type OfficeId,
  type RequestId,
  type RunId,
  type StoryKey,
  TestId,
  TestView,
} from "@dipsaus-orchestrator/contract";

import type { TestBoxRequest, TestBoxRunning } from "../../src/box/test-box";
import { appendEntries, type NewEntry } from "../../src/changelog/log";
import { CommandError } from "../../src/commands/errors";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { mergeGatesOfRun } from "../../src/run-state";
import { heldTestNotes } from "../../src/run/fix-rounds";
import { appendRunStep } from "../../src/records/run-records";
import { stopAtInReview } from "../../src/run-state/rounds";
import type { RunStoryFacts } from "../../src/run/resume";
import { findTest, openTestOf, openTestViews, testPassedFor } from "../../src/run/test-records";
import { StoryTests, type TestBoxPort } from "../../src/run/tests";
import { detect, type Probe } from "../../src/scan/detect";
import { insertProfile } from "../../src/scan/store";
import { insertStoryPr, updateStoryPr } from "../../src/records/story-prs";
import { releaseClaim } from "../../src/worktree/records";

import { H1, type StoryWorld, storyWorld } from "../merge/story-helpers";
import { MINUTE, storyRun } from "./rounds-helpers";
import { backlogLayout } from "../story-store/backlog";

const H2 = "2".repeat(40);
const STEPS = [
  { kind: "manual", check: "Open the overview", expect: "Three offices show" },
  { kind: "automated", check: "unit tests" },
  { kind: "manual", check: "Press o" },
];

function probe(scripts: Record<string, string>, lockfiles = ["bun.lock"]): Probe {
  return {
    texts: { "package.json": JSON.stringify({ name: "app", scripts }) },
    lockfiles,
    workspaceDirs: [],
    envFiles: [],
  };
}

const WITH_DEV = { test: "bun test", dev: "vite", setup: "bun scripts/setup.ts" };

class FakeTestBoxes implements TestBoxPort {
  readonly starts: TestBoxRequest[] = [];
  readonly closed: string[] = [];
  readonly reattached: string[] = [];
  /** What `reattach` answers; null: the box is gone. */
  reattachAnswer: { port: number | null } | null = { port: 52731 };
  fail: Error | null = null;
  readonly held = new Set<string>();

  async start(request: TestBoxRequest): Promise<TestBoxRunning> {
    this.starts.push(request);
    if (this.fail !== null) throw this.fail;
    this.held.add(request.testId);
    const box = `dipo-${request.testId}`;
    return request.dev === null
      ? { box, url: null, forward: null }
      : {
          box,
          url: "http://localhost:52731/",
          forward: { port: 52731, target: { address: "192.168.65.9", port: 5173 } },
        };
  }

  async close(testId: string): Promise<void> {
    this.closed.push(testId);
    this.held.delete(testId);
  }

  async reattach(input: { readonly testId: string }): Promise<{ port: number | null } | null> {
    this.reattached.push(input.testId);
    return this.reattachAnswer;
  }

  async sweep(open: ReadonlySet<string>): Promise<string[]> {
    return [...this.held].filter((id) => !open.has(id));
  }

  holds(testId: string): boolean {
    return this.held.has(testId);
  }
}

interface World {
  readonly s: StoryWorld;
  readonly tests: StoryTests;
  readonly boxes: FakeTestBoxes;
  readonly fails: { office: OfficeId; run: RunId; testId: string; head: string; note: string }[];
  readonly kicks: OfficeId[];
  readonly syncs: RunId[];
  readonly scans: string[];
  readonly entries: NewEntry[];
  config: OfficeConfig;
  ctx(story?: StoryKey): AsyncCommandContext;
}

let x: World | null = null;

afterEach(() => x?.s.close());

async function world(
  options: {
    readonly scripts?: Record<string, string>;
    readonly lockfiles?: readonly string[];
    readonly steps?: readonly unknown[];
    readonly flagged?: boolean;
  } = {},
): Promise<World> {
  const s = await storyWorld();
  const office = s.w.office;
  office.immediate(() => {
    appendRunStep(office, s.run, "phase", "review", s.w.t.clock.now());
    insertProfile(
      office,
      detect(probe(options.scripts ?? WITH_DEV, [...(options.lockfiles ?? ["bun.lock"])])),
      { scannedAt: s.w.t.clock.now(), commit: "c1" },
    );
    if (options.flagged === true) {
      office.run(
        `update backlog_mirror set labels = $labels where office_id = $office_id and key = $key`,
        { key: s.key, labels: JSON.stringify(["test-before-merge"]) },
      );
    }
  });
  const boxes = new FakeTestBoxes();
  const fails: World["fails"] = [];
  const kicks: OfficeId[] = [];
  const syncs: RunId[] = [];
  const scans: string[] = [];
  const entries: NewEntry[] = [];
  const self = { config: OFFICE_DEFAULTS } as { config: OfficeConfig };
  const tests = new StoryTests({
    stories: backlogLayout,
    offices: {
      get: (id) => (id === s.officeId ? office : undefined),
      config: () => self.config,
      loadedOffices: () => [s.officeId],
    },
    clock: s.w.t.clock,
    ids: s.w.t.ids,
    git: () => ({}) as never,
    freshProfile: async (_office, trigger) => void scans.push(trigger),
    story: async () =>
      ({ fields: { test_plan: { entries: options.steps ?? STEPS } } }) as unknown as RunStoryFacts,
    boxes,
    testDir: (testId) => `${s.w.dir}/test-boxes/${testId}`,
    testFail: async (officeId, run, test) => {
      fails.push({ office: officeId, run, ...test });
      return "queued";
    },
    kick: (officeId) => kicks.push(officeId),
    prSync: async (_office, run) => void syncs.push(run),
  });
  const built: World = {
    s,
    tests,
    boxes,
    fails,
    kicks,
    syncs,
    scans,
    entries,
    get config() {
      return self.config;
    },
    set config(value) {
      self.config = value;
    },
    ctx: (story) => {
      const now = s.w.t.clock.now();
      return {
        office,
        clock: s.w.t.clock,
        ids: s.w.t.ids,
        requestId: "req_1" as RequestId,
        origin: { kind: "cli" } as never,
        now,
        stories: new Map(
          story === undefined ? [] : [[story, { key: story, story: s.story.story } as never]],
        ),
        commit: (fn) => {
          office.immediate(() => {
            const made = [...(fn() ?? [])];
            entries.push(...made);
            appendEntries(office, made, { at: now });
          });
        },
      };
    },
  };
  x = built;
  return built;
}

async function refused(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function started(w: World) {
  const { result } = await w.tests.start(w.ctx(w.s.key), { story: w.s.key });
  return { ...result, test: TestId.parse(result.test) };
}

describe("test.start refuses (DIPO-309)", () => {
  it("a story with no manual test-plan entry, with story.notTestable", async () => {
    const w = await world({ steps: [{ kind: "automated", check: "unit tests" }] });
    const error = await refused(started(w));
    expect(error.error.code).toBe("story.notTestable");
    expect(w.boxes.starts).toEqual([]);
  });

  it("a story that is not In Review in phase review, test or merge, with test.notInReview", async () => {
    const w = await world();
    const office = w.s.w.office;
    office.immediate(() => appendRunStep(office, w.s.run, "phase", "build", w.s.w.t.clock.now()));
    expect((await refused(started(w))).error.code).toBe("test.notInReview");
    office.immediate(() => {
      appendRunStep(office, w.s.run, "phase", "merge", w.s.w.t.clock.now());
      office.run(
        `update backlog_mirror set status = 'In Progress' where office_id = $office_id and key = $key`,
        { key: w.s.key },
      );
    });
    const error = await refused(started(w));
    expect(error.error.code).toBe("test.notInReview");
    expect(error.message).toContain("In Progress");
  });

  it("an office whose install or dev is unresolved, after the fingerprint check, naming the capability", async () => {
    // Two lockfiles: the install is in conflict.
    const noLock = await world({ lockfiles: ["bun.lock", "package-lock.json"] });
    const install = await refused(started(noLock));
    expect(noLock.scans).toEqual(["test"]);
    expect(install.error).toMatchObject({
      code: "test.refused",
      details: { capability: "install" },
    });
    noLock.s.close();
    x = null;
    const noDev = await world({ scripts: { test: "bun test" } });
    const dev = await refused(started(noDev));
    expect(dev.error).toMatchObject({ code: "test.refused", details: { capability: "dev" } });
    expect(dev.message).toContain('"dev"');
    expect(noDev.boxes.starts).toEqual([]);
  });
});

describe("test.start (DIPO-309)", () => {
  it("makes a new test box from the pushed head and replies with the steps, URL, box, shell line and test id", async () => {
    const w = await world();
    const result = await started(w);
    expect(TestId.safeParse(result.test).success).toBe(true);
    expect(result).toEqual({
      test: result.test,
      head: H1,
      checkout: `dipo-${result.test}`,
      steps: [{ check: "Open the overview", expect: "Three offices show" }, { check: "Press o" }],
      url: "http://localhost:52731/",
      shell: "dipo test shell DIPO-7",
    });
    const [request] = w.boxes.starts;
    expect(request).toMatchObject({ testId: result.test, head: H1 });
    expect(request?.install?.commands).toEqual([["bun", "install", "--frozen-lockfile"]]);
    expect(request?.setup?.commands).toEqual([["bun", "run", "setup"]]);
    expect(request?.dev).toMatchObject({ command: ["bun", "run", "dev"], cwd: "/work" });
    // test.started, and the test in office.snapshot.
    const event = w.entries.find((entry) => entry.type === "test.started");
    expect(TestView.parse(event?.delta)).toMatchObject({ test: result.test, url: result.url });
    expect(openTestViews(w.s.w.office).map((view) => view.test)).toEqual([result.test]);
    // The same head again: the open test, unchanged.
    const again = await w.tests.start(w.ctx(w.s.key), { story: w.s.key });
    expect(again).toEqual({ result: { ...result, test: result.test }, changed: false });
    expect(w.boxes.starts).toHaveLength(1);
  });

  it("gives a product with nothing to start no dev and no URL, and tests an unflagged story too", async () => {
    const w = await world({ scripts: { test: "bun test" } });
    w.s.w.office.immediate(() =>
      w.s.w.office.run(
        `insert into office_scan_marks (office_id, nothing_to_start, marked_at)
         values ($office_id, 1, 0)`,
      ),
    );
    const result = await started(w);
    expect(w.boxes.starts[0]?.dev).toBeNull();
    expect(result.url).toBeUndefined();
    expect(result.shell).toBe("dipo test shell DIPO-7");
  });

  it("closes the test and answers test.startFailed when the box fails", async () => {
    const w = await world();
    w.boxes.fail = new Error("`dev` printed no URL within 300 seconds");
    const error = await refused(started(w));
    expect(error.error.code).toBe("test.startFailed");
    expect(error.message).toContain("printed no URL");
    expect(openTestOf(w.s.w.office, w.s.key)).toBeNull();
    expect(openTestViews(w.s.w.office)).toEqual([]);
  });
});

describe("test.record (DIPO-309)", () => {
  it("a pass decides the test gate for its head, and a flagged story's merge gate waiting only on the flag", async () => {
    const w = await world({ flagged: true });
    await w.s.tick();
    expect(mergeGatesOfRun(w.s.w.office, w.s.run)[0]).toMatchObject({
      waits: ["testBeforeMerge"],
      decision: null,
    });
    const { test } = await started(w);
    const recorded = await w.tests.record(w.ctx(), { test, result: "pass" });
    expect(recorded.result).toEqual({ test, result: "pass" });
    expect(findTest(w.s.w.office, test)).toMatchObject({ result: "pass", endReason: "recorded" });
    expect(testPassedFor(w.s.w.office, w.s.key, H1)).toBe(true);
    const testGate = w.s.w.office.get<{ kind: string; decision: string; decided_by: string }>(
      `select g.kind, d.decision, d.decided_by from gates g join gate_decisions d
         on d.office_id = g.office_id and d.gate_id = g.gate_id
       where g.office_id = $office_id and g.kind = 'test'`,
    );
    expect(testGate).toEqual({ kind: "test", decision: "approved", decided_by: "maintainer" });
    expect(mergeGatesOfRun(w.s.w.office, w.s.run)[0]?.decision).toMatchObject({
      decision: "approved",
      by: "maintainer",
    });
    expect(w.entries.map((entry) => entry.type)).toContain("test.recorded");
    expect(w.boxes.closed).toEqual([test]);
    expect(w.kicks).toEqual([w.s.officeId]);
    expect(w.syncs).toEqual([w.s.run]);
    expect(w.fails).toEqual([]);
  });

  it("refuses a pass on an older head than the story's current head with test.closed, and closes it", async () => {
    const w = await world();
    const { test } = await started(w);
    w.s.w.office.immediate(() =>
      updateStoryPr(w.s.w.office, w.s.run, { headSha: H2, title: "t", bodyHash: "h" }),
    );
    const error = await refused(w.tests.record(w.ctx(), { test, result: "pass" }));
    expect(error.error.code).toBe("test.closed");
    expect(findTest(w.s.w.office, test)).toMatchObject({ result: null, endReason: "new-head" });
    expect(testPassedFor(w.s.w.office, w.s.key, H1)).toBe(false);
    expect(w.boxes.closed).toEqual([test]);
    // A test already closed or recorded is refused too.
    expect((await refused(w.tests.record(w.ctx(), { test, result: "pass" }))).error.code).toBe(
      "test.closed",
    );
  });

  it("a fail sends the note once to the same builder, keyed on the test id, and leaves the gate open", async () => {
    const w = await world({ flagged: true });
    await w.s.tick();
    const { test } = await started(w);
    await w.tests.record(w.ctx(), { test, result: "fail", note: "  Esc does not go back.  " });
    expect(w.fails).toEqual([
      { office: w.s.officeId, run: w.s.run, testId: test, head: H1, note: "Esc does not go back." },
    ]);
    expect(findTest(w.s.w.office, test)).toMatchObject({
      result: "fail",
      note: "Esc does not go back.",
    });
    // Held on the run in the record's own transaction: never lost, whatever the round does.
    expect(heldTestNotes(w.s.w.office, w.s.run).map((held) => held.item.signature)).toEqual([
      `test:${test}`,
    ]);
    expect(mergeGatesOfRun(w.s.w.office, w.s.run)[0]?.decision).toBeNull();
    expect(testPassedFor(w.s.w.office, w.s.key, H1)).toBe(false);
  });
});

/** The `test.ended` events of the office's change log. */
function endedEvents(w: World): { test: string; reason: string }[] {
  return w.s.w.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'test.ended' order by seq",
    )
    .map((row) => {
      const delta = JSON.parse(row.delta) as { test: string; reason: string };
      return { test: delta.test, reason: delta.reason };
    });
}

describe("the test sweep (DIPO-309)", () => {
  it("lets two stories each have an open test in its own box", async () => {
    const w = await world();
    const other = storyRun(w.s.w, { story: "DIPO-8" });
    const office = w.s.w.office;
    const now = w.s.w.t.clock.now();
    office.immediate(() => {
      stopAtInReview(office, other.run, now);
      appendRunStep(office, other.run, "phase", "test", now);
      insertStoryPr(office, {
        runId: other.run,
        key: other.key,
        number: 8,
        url: "https://github.com/example/demo/pull/8",
        branch: "DIPO-8/a-story",
        base: "main",
        headSha: H2,
        state: "open",
        title: "t",
        bodyHash: "h",
        openedAt: now,
        closedAt: null,
      });
    });
    const first = await started(w);
    const second = (await w.tests.start(w.ctx(other.key), { story: other.key })).result;
    expect(second.head).toBe(H2);
    expect(second.checkout).not.toBe(first.checkout);
    expect(
      openTestViews(office)
        .map((view): string => view.story)
        .toSorted(),
    ).toEqual(["DIPO-7", "DIPO-8"]);
    await w.tests.sweep();
    expect(openTestViews(office)).toHaveLength(2);
  });

  it("closes a test on a new head, and after timeouts.testIdleMinutes on the clock", async () => {
    const w = await world();
    const first = (await started(w)).test;
    w.s.w.office.immediate(() =>
      updateStoryPr(w.s.w.office, w.s.run, { headSha: H2, title: "t", bodyHash: "h" }),
    );
    await w.tests.sweep();
    expect(findTest(w.s.w.office, first)?.endReason).toBe("new-head");
    expect(endedEvents(w)).toEqual([{ test: first, reason: "new-head" }]);
    const second = (await started(w)).test;
    w.config = {
      ...OFFICE_DEFAULTS,
      timeouts: { ...OFFICE_DEFAULTS.timeouts, testIdleMinutes: 30 },
    };
    w.s.w.t.clock.advance(29 * MINUTE);
    await w.tests.sweep();
    expect(findTest(w.s.w.office, second)?.endedAt).toBeNull();
    w.s.w.t.clock.advance(MINUTE);
    await w.tests.sweep();
    expect(findTest(w.s.w.office, second)?.endReason).toBe("idle");
    expect(w.boxes.closed).toEqual([first, second]);
  });

  it("closes a test when its story is dropped, discarded or merged, or leaves review", async () => {
    for (const [reason, expected] of [
      ["drop", "dropped"],
      ["discard", "discarded"],
      ["done", "merged"],
    ] as const) {
      const w = await world();
      const { test } = await started(w);
      w.s.w.office.immediate(() =>
        releaseClaim(w.s.w.office, w.s.run, {
          at: w.s.w.t.clock.now(),
          reason,
          ending: reason === "done" ? "done" : "dropped",
          keepBranch: false,
        }),
      );
      await w.tests.sweep();
      expect(findTest(w.s.w.office, test)?.endReason).toBe(expected);
      expect(w.boxes.closed).toEqual([test]);
      w.s.close();
      x = null;
    }
    const w = await world();
    const { test } = await started(w);
    w.s.w.office.immediate(() =>
      w.s.w.office.run(
        `update backlog_mirror set status = 'In Progress' where office_id = $office_id and key = $key`,
        { key: w.s.key },
      ),
    );
    await w.tests.sweep();
    expect(findTest(w.s.w.office, test)?.endReason).toBe("not-in-review");
  });

  it("keeps an open test across a restart, and closes one whose box is gone", async () => {
    const w = await world();
    const { test } = await started(w);
    await w.tests.recover();
    expect(w.boxes.reattached).toEqual([test]);
    expect(findTest(w.s.w.office, test)?.endedAt).toBeNull();
    w.boxes.reattachAnswer = null;
    await w.tests.recover();
    expect(findTest(w.s.w.office, test)?.endReason).toBe("box-lost");
  });
});
