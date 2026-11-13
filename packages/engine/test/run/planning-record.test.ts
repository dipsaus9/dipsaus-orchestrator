// The record of a planning session (DIPO-448, 0007) on a fixture-built test database: every
// confirmed choice, filed or edited story and open question is stored in order, and a fresh Claude
// session starts when the context nears full or the session continues after its model session
// ended, with a first message code builds from the record.

import { describe, expect, it } from "bun:test";

import { type PlanningView, RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import {
  addPlanningEntry,
  continuableSession,
  openQuestions,
  planningRecordText,
  readPlanningRecord,
} from "../../src/records/planning-record";
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

/** The context size of one message, as the model proxy would count it for the same request. */
const messageOf = (total: number) => ({
  input: 10,
  output: 100,
  cacheCreate: 1_000,
  cacheRead: total - 1_110,
});

const EXPECTED_RECORD = [
  "Decisions the maintainer confirmed:\n- Which tier?: M",
  "Stories filed or edited:\n- DIPO-501: filed\n- DIPO-501: edited",
  "Open questions:\n- Who owns the retro table?",
].join("\n\n");

/** A record entry of a model session, for the pure text. */
const recorded = (seq: number, kind: "started" | "ended" | "message" | "answer", text: string) => ({
  seq,
  kind,
  run: "run-a",
  subject: null,
  proposal: null,
  outputOffset: 0,
  text,
  at: seq * 1_000,
});

describe("the record of a planning session (DIPO-448)", () => {
  it("stores each confirmed choice, filed or edited story and open question in order", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      fill(w);
      const entries = readPlanningRecord(w.office, run);
      expect(entries.map((entry) => [entry.kind, entry.subject, entry.text])).toEqual([
        ["goal", "plan", "Plan the retro stories"],
        ["started", "start", ""],
        ["answer", null, "Answer 1."],
        ["choice", "Which tier?", "M"],
        ["story", "DIPO-501", "filed"],
        ["question", null, "Who owns the retro table?"],
        ["story", "DIPO-501", "edited"],
      ]);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(planningRecordText(entries)).toBe(EXPECTED_RECORD);
      // A choice that answers a question closes it.
      w.sessions.record(officeOf(w), {
        kind: "choice",
        subject: "Who owns the retro table?",
        text: "The engine",
      });
      expect(openQuestions(readPlanningRecord(w.office, run))).toEqual([]);
    }));

  it("keeps each maintainer message and the last answer of each model session, with time, run and output offset", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      w.t.clock.advance(1_000);
      const sentAt = w.t.clock.now();
      await w.sessions.message(commandContext(w), { text: "What about the retro table?" });
      await until(() => {
        w.t.clock.advance(1_000);
        return readPlanningRecord(w.office, run).some((e) => e.text === "Answer 2.");
      });
      const kept = readPlanningRecord(w.office, run).filter(
        (entry) => entry.kind === "message" || entry.kind === "answer",
      );
      // One answer per model session: the second replaced the first.
      expect(kept.map((entry) => [entry.kind, entry.run, entry.text])).toEqual([
        ["message", run, "What about the retro table?"],
        ["answer", run, "Answer 2."],
      ]);
      expect(kept[0]?.at).toBe(sentAt);
      expect(kept[0]?.outputOffset).toBeGreaterThan(0);
      expect(kept[1]?.outputOffset).toBeGreaterThanOrEqual(kept[0]?.outputOffset ?? 0);
      expect(kept[1]?.at).toBeGreaterThan(sentAt);
    }));

  it("keeps the sent answers of a question block as a maintainer message", () =>
    withWorld(async (w) => {
      const block = {
        header: "Scope",
        question: "Cover archived stories?",
        purpose: "It decides the columns.",
        options: [
          { label: "No", description: "Active only." },
          { label: "Yes", description: "All of them." },
        ],
      };
      w.answerText = (n) =>
        n === 1
          ? `Questions.\n\n\`\`\`dipo-questions\n${JSON.stringify({ questions: [block] })}\n\`\`\``
          : `Answer ${n}.`;
      const { run } = await started(w);
      await w.sessions.answer(commandContext(w), { block: 1, answers: [{ option: 0 }] });
      const message = readPlanningRecord(w.office, run).findLast((e) => e.kind === "message");
      expect(message).toMatchObject({ run, outputOffset: expect.any(Number) });
      expect(message?.text).toContain("Cover archived stories?");
      expect(message?.text).toContain("No");
    }));

  it("renders the last maintainer message, the last answer and the continue line for a fresh model session", () => {
    const fresh = planningRecordText([
      recorded(1, "started", ""),
      recorded(2, "message", "Early message"),
      recorded(3, "answer", "Early answer"),
      recorded(4, "message", "Late message"),
      recorded(5, "answer", "Late answer"),
      recorded(6, "ended", "context-full"),
      recorded(7, "started", ""),
    ]);
    expect(fresh).toContain("This continues the planning session");
    expect(fresh).toContain("Late message");
    expect(fresh).toContain("Late answer");
    expect(fresh).not.toContain("Early");
    // A first model session has no continue line.
    expect(
      planningRecordText([recorded(1, "started", ""), recorded(2, "message", "Hello")]),
    ).not.toContain("continues");
  });

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
      // The second answer's message is as big as the limit allows.
      w.answerUsage = (n) => (n === 2 ? messageOf(100_000) : undefined);
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
      expect(text).toContain(`<record>\n${EXPECTED_RECORD}\n\nThis continues the planning session`);
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
      expect(kinds.filter((kind) => kind !== "answer").slice(-2)).toEqual(["ended", "started"]);
      expect(w.sessions.liveRuns()).toEqual([fresh?.run ?? ""]);
    }));

  it("names the session and lists its three model sessions and the maintainer's messages in the view (DIPO-490)", () =>
    withWorld(async (w) => {
      const { run } = await started(w);
      w.answerUsage = (n) => (n === 2 || n === 4 ? messageOf(100_000) : undefined);
      const waitFresh = async (previous: string): Promise<PlanningView | null> => {
        await until(() => {
          w.t.clock.advance(1_000);
          const view = w.sessions.view(officeOf(w));
          return view?.state === "waiting" && view.run !== previous;
        });
        return w.sessions.view(officeOf(w));
      };
      await w.sessions.message(commandContext(w), { text: "First." });
      const second = await waitFresh(run as string);
      await w.sessions.message(commandContext(w), { text: "Second." });
      const third = await waitFresh(second?.run ?? "");
      expect(third?.session as string).toBe(run);
      expect(third?.sessions?.map((item) => [item.run as string, item.ended])).toEqual([
        [run as string, "context-full"],
        [second?.run as string, "context-full"],
        [third?.run as string, undefined],
      ]);
      expect(third?.sessions?.every((item) => item.startedAt !== undefined)).toBe(true);
      expect(third?.sessions?.[0]?.endedAt).toBeDefined();
      expect(third?.messages?.map((item) => [item.run as string, item.text])).toEqual([
        [run as string, "First."],
        [second?.run as string, "Second."],
      ]);
      expect(third?.messages?.every((item) => item.outputOffset > 0)).toBe(true);
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
      expect(firstMessage(w, 1)).toContain(
        `<record>\n${EXPECTED_RECORD}\n\nThis continues the planning session`,
      );
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
      expect(firstMessage(w, 1)).toContain(
        `<record>\n${EXPECTED_RECORD}\n\nThis continues the planning session`,
      );
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
