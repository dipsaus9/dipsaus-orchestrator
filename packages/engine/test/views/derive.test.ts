// Story and work view derivation (DIPO-52; 0009 section 3): the column table, the health
// precedence table, waiting-on, gate messages and parks from the index, and the budget share.

import { describe, expect, it } from "bun:test";

import {
  type Health,
  KNOWN_HEALTH,
  type Lifecycle,
  type QueueColumn,
  StoryId,
  StoryKey,
  StoryView,
  type WatchdogSignal,
  WorkView,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { storeGateDecision } from "../../src/gate-decisions/decisions";
import { markStuck, raiseSignal } from "../../src/run/signals";
import { activeStoryViews, deriveColumn, deriveStoryView, storyView } from "../../src/views/story";
import { deriveHealth, workView } from "../../src/views/work";
import { addOffice, openTestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { keyOf, startRun } from "./helpers";

const KEY = StoryKey.parse("sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const BY_YOU = { reason: "by-maintainer", from: "Ready" as const, note: "after M2", since: 0 };

describe("column table", () => {
  const cases: [Lifecycle, Parameters<typeof deriveColumn>[0], QueueColumn][] = [
    ["Draft", { lifecycle: "Draft" }, "draft"],
    ["Refined", { lifecycle: "Refined" }, "refined"],
    ["Ready", { lifecycle: "Ready" }, "ready"],
    ["Ready", { lifecycle: "Ready", waitingOn: [] }, "ready"],
    ["Ready", { lifecycle: "Ready", waitingOn: ["DIPO-1"] }, "waiting"],
    ["In Progress", { lifecycle: "In Progress" }, "running"],
    ["In Review", { lifecycle: "In Review" }, "review"],
    ["Parked", { lifecycle: "Parked" }, "desk"],
    ["Done", { lifecycle: "Done" }, "done"],
    // Waiting-on only counts for Ready: a Refined story with open dependencies stays refined.
    ["Refined", { lifecycle: "Refined", waitingOn: ["DIPO-1"] }, "refined"],
  ];
  for (const [lifecycle, facts, column] of cases) {
    it(`${lifecycle} ${JSON.stringify({ ...facts, lifecycle: undefined })} is ${column}`, () => {
      expect(deriveColumn(facts)).toBe(column);
    });
  }

  it("covers the eight 0009 columns", () => {
    const columns = new Set(cases.map(([, , column]) => column));
    expect([...columns].toSorted()).toEqual(
      ["desk", "done", "draft", "ready", "refined", "review", "running", "waiting"].toSorted(),
    );
  });
});

describe("story view", () => {
  it("names what a waiting story waits on, the park of a parked one, and Refined gate messages", () => {
    const base = { key: KEY, story: StoryId.parse("DIPO-7"), title: "Seven" };
    const waiting = deriveStoryView({ ...base, lifecycle: "Ready", waitingOn: ["DIPO-1"] });
    expect(waiting).toMatchObject({ column: "waiting", waitingOn: ["DIPO-1"] });
    expect(StoryView.parse(waiting)).toEqual(waiting);
    const parked = deriveStoryView({ ...base, lifecycle: "Parked", park: BY_YOU });
    expect(parked).toMatchObject({
      column: "desk",
      parked: {
        reason: "by-maintainer",
        detail: "after M2",
        from: "Ready",
        since: new Date(0).toISOString(),
      },
    });
    const line = "ready TASK-1 failed R07: milestone is missing";
    const sizing = "TASK-1 cannot start: story.tooLarge: too large";
    const failures = [{ rule: "R07", message: line }, { message: sizing }];
    const refined = deriveStoryView({ ...base, lifecycle: "Refined", gateFailures: failures });
    expect(refined.gateMessages).toEqual([line, sizing]);
    // The rule id is data next to the message (DIPO-97); a message no rule gave has no entry.
    expect(refined.gateFailures).toEqual([
      { rule: "R07", message: line, text: "milestone is missing" },
    ]);
    expect(StoryView.parse(refined)).toEqual(refined);
    const sized = deriveStoryView({ ...base, lifecycle: "Refined", gateFailures: [failures[1]!] });
    expect(sized.gateMessages).toEqual([sizing]);
    expect(sized).not.toHaveProperty("gateFailures");
    // Gate messages are for Refined stories only.
    const ready = deriveStoryView({ ...base, lifecycle: "Ready", gateFailures: failures });
    expect(ready).not.toHaveProperty("gateMessages");
    expect(ready).not.toHaveProperty("gateFailures");
  });

  it("derives waiting-on, parks and gate messages from the index and the gate decisions", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("TASK-1", { status: "Ready", waitingOn: ["TASK-9"] }),
          task("TASK-2", {
            status: "Parked",
            park: { reason: "by-maintainer", from: "Ready", note: "later" },
          }),
          task("TASK-3"),
        ]);
        const key3 = keyOf(office, "TASK-3");
        office.immediate(() =>
          storeGateDecision(office, t.ids, {
            key: key3,
            result: {
              mode: "ready",
              passed: false,
              failures: [{ rule: "R07", message: "ready TASK-3 failed R07: milestone is missing" }],
            } as never,
            contentHash: "h",
            at: t.clock.now(),
          }),
        );
        const views = new Map(activeStoryViews(office).map((view) => [view.story, view]));
        expect(views.get(StoryId.parse("TASK-1"))).toMatchObject({
          column: "waiting",
          waitingOn: ["TASK-9"],
        });
        expect(views.get(StoryId.parse("TASK-2"))).toMatchObject({
          column: "desk",
          parked: { reason: "by-maintainer", detail: "later", from: "Ready" },
        });
        expect(views.get(StoryId.parse("TASK-3"))?.gateMessages).toEqual([
          "ready TASK-3 failed R07: milestone is missing",
        ]);
        expect(views.get(StoryId.parse("TASK-3"))?.gateFailures).toEqual([
          {
            rule: "R07",
            message: "ready TASK-3 failed R07: milestone is missing",
            text: "milestone is missing",
          },
        ]);

        // The park keeps the time it was first seen; the dependency becoming Done makes it ready.
        const since = views.get(StoryId.parse("TASK-2"))?.parked?.since;
        t.clock.advance(60_000);
        pass(t, office, [
          task("TASK-1", { status: "Ready", waitingOn: [] }),
          task("TASK-2", {
            status: "Parked",
            park: { reason: "by-maintainer", from: "Ready", note: "later" },
          }),
          task("TASK-3"),
        ]);
        expect(storyView(office, keyOf(office, "TASK-1"))).toMatchObject({ column: "ready" });
        expect(storyView(office, keyOf(office, "TASK-1"))).not.toHaveProperty("waitingOn");
        expect(storyView(office, keyOf(office, "TASK-2"))?.parked?.since).toBe(since);
      } finally {
        t.state.close();
      }
    }));
});

describe("health precedence", () => {
  const base = {
    signals: [] as WatchdogSignal[],
    stuck: false,
    exitUnprocessed: false,
    loop: 0,
    loopCap: 3,
  };
  const cases: [string, Parameters<typeof deriveHealth>[0], Health][] = [
    ["no fact", base, "busy"],
    ["no-output within the stall wait", { ...base, signals: ["no-output"] }, "quiet"],
    ["no-output past the stall wait", { ...base, signals: ["no-output"], stuck: true }, "stuck"],
    ["same-failure over no-output", { ...base, signals: ["no-output", "same-failure"] }, "looping"],
    ["the last allowed loop", { ...base, loop: 3, loopCap: 3 }, "looping"],
    ["a loop below the cap", { ...base, loop: 2, loopCap: 3 }, "busy"],
    ["no loop cap", { ...base, loop: 0, loopCap: 0 }, "busy"],
    // A question parks and a plan limit pauses the office's starts (0020): no health of their own.
    ["a plan-limit fact from before 0020", { ...base, signals: ["plan-limit"] }, "busy"],
    ["host-lost over everything", { ...base, signals: ["same-failure", "host-lost"] }, "lost"],
    ["an unprocessed exit", { ...base, exitUnprocessed: true, signals: ["no-output"] }, "lost"],
  ];
  it("derives only the five health states of 0009", () => {
    const all = new Set(cases.map((entry) => deriveHealth(entry[1])));
    for (const health of all) expect(KNOWN_HEALTH as readonly string[]).toContain(health);
  });
  for (const [name, facts, health] of cases) {
    it(`${name} is ${health}`, () => expect(deriveHealth(facts)).toBe(health));
  }
});

describe("work view", () => {
  it("derives phase, progress, health and the budget share from the run's facts", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("TASK-1", { status: "In Progress", criteria: { met: 1, total: 4 } }),
        ]);
        const started = startRun(t, office, "TASK-1", dir, { budget: 1000 });
        office.immediate(() => {
          office.run(
            `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input,
               output, cache_create, cache_create_5m, cache_read, turns, updated_at)
             values ($office_id, $run, $agent, 'haiku', 'developer', 'S', 100, 50, 100, 100, 900, 2, 0)`,
            { run: started.run, agent: started.agent },
          );
          raiseSignal(office, started.run, "no-output", t.clock.now());
        });
        const view = workView(office, started.run);
        expect(view).not.toBeNull();
        expect(WorkView.parse(view)).toEqual(view as WorkView);
        expect(view).toMatchObject({
          work: started.work,
          phase: "setup",
          progress: { criteriaMet: 1, criteriaTotal: 4, loop: 0, loopCap: 3, verify: "none" },
          health: "quiet",
          startedAt: new Date(t.clock.now()).toISOString(),
        });
        // Budget: input + output + cache creation over the limit; cache reads do not count.
        expect(view?.usage.budget).toEqual({ unit: "tokens", limit: 1000, used: 250 });
        expect(view?.usage.budgetShare).toBe(0.25);
        expect(view?.usage.run.turns).toBe(2);
        // The story view names who works on it.
        expect(storyView(office, started.key)?.work).toEqual(started.work);
        // Past the stall wait the same `no-output` fact is stuck: one fact, two health values.
        office.immediate(() => markStuck(office, started.run, t.clock.now()));
        expect(workView(office, started.run)?.health).toBe("stuck");
        expect(
          office.all(
            "select signal from run_signals where office_id = $office_id and cleared_at is null",
          ),
        ).toEqual([{ signal: "no-output" }]);
      } finally {
        t.state.close();
      }
    }));
});
