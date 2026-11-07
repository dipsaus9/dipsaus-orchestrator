// The record of a planning session (DIPO-448, 0007) on a fixture-built test database: every
// confirmed choice, filed or edited story and open question is stored in order, and a fresh Claude
// session starts when the context nears full or the session continues after its model session
// ended, with a first message code builds from the record.

import { describe, expect, it } from "bun:test";

import { RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import {
  addPlanningEntry,
  continuableSession,
  openQuestions,
  planningRecordText,
  readPlanningRecord,
} from "../../src/records/planning-record";
import { proxiedUsageLedger } from "../../src/records/proxied-usage";
import { insertRun } from "../../src/records/run-records";
import { addOffice, openTestState } from "../commands/helpers";
import { draft, entriesAfter, pass } from "../stories/helpers";
import { commandContext, planningWorld, type PlanningWorld, until } from "./planning-world";

const HOUR = 60 * 60_000;

const withWorld = (fn: (w: PlanningWorld) => Promise<void>, contextTokens = 100_000) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir, { contextTokens }));
    } finally {
      t.state.close();
    }
  });

const officeOf = (w: PlanningWorld) => w.office.officeId as never;

async function started(w: PlanningWorld) {
  const outcome = await w.sessions.start(commandContext(w), {
    kind: "plan",
    goal: "Plan the retro stories",
  });
  await until(() => w.sessions.view(officeOf(w))?.state === "waiting");
  return outcome.result;
}

/** Fills the record with one of each entry the maintainer's confirmations write. */
function fill(w: PlanningWorld) {
  const send = (args: Parameters<PlanningWorld["sessions"]["recordCommand"]>[1]) =>
    w.sessions.recordCommand(commandContext(w), args);
  send({ kind: "choice", subject: "Which tier?", text: "M" });
  send({ kind: "story", subject: StoryId.parse("DIPO-501"), text: "filed" });
  send({ kind: "question", text: "Who owns the retro table?" });
  send({ kind: "story", subject: StoryId.parse("DIPO-501"), text: "edited" });
}

const planningEvents = (w: PlanningWorld, type: string) =>
  entriesAfter(w.office).filter((entry) => entry.type === type);

const firstMessage = (w: PlanningWorld, n: number): string => {
  const first = JSON.parse(w.plans[n]?.stdin[0] ?? "{}") as { message: { content: string } };
  return first.message.content;
};

/** Counts far more tokens against the run than any context holds. */
function overfill(w: PlanningWorld, run: string) {
  const agent = w.sessions.view(officeOf(w))?.agent ?? "";
  proxiedUsageLedger({ owner: () => null, office: () => w.office, clock: w.t.clock }).open(
    { office: w.office.officeId as never, run: RunId.parse(run), agent: agent as never },
    "opus",
  )({
    model: "claude-opus-5-5",
    input: 500_000,
    output: 0,
    cacheCreate: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
  });
}

const EXPECTED_RECORD = [
  "Decisions the maintainer confirmed:\n- Which tier?: M",
  "Stories filed or edited:\n- DIPO-501: filed\n- DIPO-501: edited",
  "Open questions:\n- Who owns the retro table?",
].join("\n\n");

describe("the record of a planning session (DIPO-448)", () => {
  it("stores each confirmed choice, filed or edited story and open question in order", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      fill(w);
      const entries = readPlanningRecord(w.office, run);
      expect(entries.map((entry) => [entry.kind, entry.subject, entry.text])).toEqual([
        ["goal", "plan", "Plan the retro stories"],
        ["started", "start", ""],
        ["choice", "Which tier?", "M"],
        ["story", "DIPO-501", "filed"],
        ["question", null, "Who owns the retro table?"],
        ["story", "DIPO-501", "edited"],
      ]);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(planningRecordText(entries)).toBe(EXPECTED_RECORD);
      // A choice that answers a question closes it.
      w.sessions.record(officeOf(w), {
        kind: "choice",
        subject: "Who owns the retro table?",
        text: "The engine",
      });
      expect(openQuestions(readPlanningRecord(w.office, run))).toEqual([]);
    }));

  it("keeps the record of one session apart from another's and from another office's", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const other = addOffice(t);
        const mine = planningWorld(t, dir);
        const run = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1F");
        mine.office.immediate(() =>
          addPlanningEntry(mine.office, run, { kind: "goal", subject: "plan", text: "A", at: 1 }),
        );
        other.immediate(() =>
          addPlanningEntry(other, run, { kind: "goal", subject: "plan", text: "B", at: 1 }),
        );
        expect(readPlanningRecord(mine.office, run).map((entry) => entry.text)).toEqual(["A"]);
        expect(readPlanningRecord(other, run).map((entry) => entry.text)).toEqual(["B"]);
        expect(readPlanningRecord(mine.office, "run-b")).toEqual([]);
      } finally {
        t.state.close();
      }
    }));

  it("starts a fresh model session from the record when the context nears full, and says so", () =>
    withWorld(async (w) => {
      pass(w.t, w.office, [draft("DRAFT-1", { title: "Retro numbers" })]);
      const { run } = await started(w);
      fill(w);
      overfill(w, run);
      await w.sessions.message(commandContext(w), { text: "Go on." });
      // The answer ends the turn, then the stopped session's exit is read on the next pass.
      await until(() => {
        w.t.clock.advance(1_000);
        return w.plans.length === 2;
      });
      await until(() => w.sessions.view(officeOf(w))?.state === "waiting");
      const fresh = w.sessions.view(officeOf(w));
      expect(fresh?.run).not.toBe(run);
      expect(w.boxes.ended).toHaveLength(1);
      const text = firstMessage(w, 1);
      expect(text).toContain("goal: Plan the retro stories");
      expect(text).toContain(`<record>\n${EXPECTED_RECORD}\n</record>`);
      // The facts of the first message stay.
      expect(text).toContain(
        "<drafts>\n- DRAFT-1: Retro numbers (origin: not recorded; filed by hand or before dipo kept it)\n</drafts>",
      );
      const continued = planningEvents(w, "planning.continued");
      expect(continued.map((entry) => entry.delta)).toMatchObject([
        { run: fresh?.run, previous: run, reason: "context-full" },
      ]);
      // The record goes on in the same session, with the fresh model session's start.
      const kinds = readPlanningRecord(w.office, run).map((entry) => entry.kind);
      expect(kinds.slice(-2)).toEqual(["ended", "started"]);
      expect(w.sessions.liveRuns()).toEqual([fresh?.run ?? ""]);
    }));

  it("continues after an idle end in a fresh model session built from the record", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      fill(w);
      w.t.clock.advance(24 * HOUR);
      await until(() => w.sent.length === 1);
      w.t.clock.advance(1_000);
      await until(() => w.sessions.view(officeOf(w)) === null);
      expect(continuableSession(w.office)).toMatchObject({
        session: run,
        previous: run,
        reason: "idle",
        goal: "Plan the retro stories",
      });
      const outcome = await w.sessions.continue(commandContext(w));
      expect(outcome.result.run).not.toBe(run);
      expect(w.plans).toHaveLength(2);
      expect(firstMessage(w, 1)).toContain(`<record>\n${EXPECTED_RECORD}\n</record>`);
      expect(planningEvents(w, "planning.continued").map((entry) => entry.delta)).toMatchObject([
        { run: outcome.result.run, previous: run, reason: "idle" },
      ]);
    }));

  it("continues after a daemon restart, whether it stopped cleanly or left its run open", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      fill(w);
      await w.sessions.stopAll();
      expect(continuableSession(w.office)).toMatchObject({
        session: run,
        reason: "daemon-stopped",
      });
      // A run a crashed daemon left open: recovery ends it and the record says why.
      const left = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E");
      w.office.immediate(() => {
        insertRun(w.office, {
          runId: left,
          kind: "session",
          key: null,
          story: null,
          tier: null,
          role: "planner",
          model: "opus",
          startSha: null,
          branch: null,
          budgetUnit: "tokens",
          budgetLimit: 0,
          loopCap: 0,
          reviewRoundCap: null,
          configHash: "h",
          overrideKeys: null,
          runProfileId: null,
          startedAt: w.t.clock.now(),
        });
        addPlanningEntry(w.office, run, {
          kind: "started",
          run: left,
          subject: "start",
          text: "",
          at: 1,
        });
      });
      expect(continuableSession(w.office)).toBeNull();
      expect(w.sessions.recover([officeOf(w)])).toBe(1);
      expect(continuableSession(w.office)).toMatchObject({ session: run, previous: left });
      const outcome = await w.sessions.continue(commandContext(w));
      expect(firstMessage(w, 1)).toContain(`<record>\n${EXPECTED_RECORD}\n</record>`);
      expect(planningEvents(w, "planning.continued").map((entry) => entry.delta)).toMatchObject([
        { run: outcome.result.run, previous: left, reason: "daemon-stopped" },
      ]);
    }));

  it("does not continue a session the maintainer ended", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      await w.sessions.end(commandContext(w));
      w.t.clock.advance(1_000);
      await until(() => w.sessions.view(officeOf(w)) === null);
      expect(continuableSession(w.office)).toBeNull();
      const refused = await w.sessions.continue(commandContext(w)).catch((error: unknown) => error);
      expect((refused as CommandError).error.code).toBe("planning.notContinuable");
      expect(readPlanningRecord(w.office, run).at(-1)).toMatchObject({
        kind: "ended",
        text: "maintainer",
      });
    }));

  it("refuses to continue while a session is open", () =>
    withWorld(async (w) => {
      await started(w);
      const refused = await w.sessions.continue(commandContext(w)).catch((error: unknown) => error);
      expect((refused as CommandError).error.code).toBe("planning.open");
    }));
});
