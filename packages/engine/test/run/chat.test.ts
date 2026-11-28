// The office chat (DIPO-523, 0024) on a fixture-built test database, with the real Claude worker
// port and a scripted worker host: no `claude` and no box start.
//
// - One standing chat per office, in threads: `chat.message` opens a thread titled by the message
//   when none is open, goes to the open one otherwise, and never answers `planning.open`.
// - One model session answers per office: a message sent while it answers is held and sent, with
//   the others held, when the answer ends.
// - `/end` closes the thread with its Ready step; the planning commands are its aliases.

import { describe, expect, it } from "bun:test";

import { type ChatContext, RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import { addPlanningEntry, readPlanningRecord } from "../../src/records/planning-record";
import { fileTargetOf, storyFieldsOf } from "../../src/run/planning-proposals";
import { chatCommandOf, threadTitle } from "../../src/run/planning-session";
import { FILE_KIND, type PlannedFiling, type PlanningLane } from "../../src/story-store/planning";
import { openTestState } from "../commands/helpers";
import { entriesAfter } from "../stories/helpers";
import {
  commandContext,
  planningRun,
  planningWorld,
  type PlanningWorld,
  type PlanningWorldOptions,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const DESK: ChatContext = { room: "desk" };

const withWorld = (fn: (w: PlanningWorld) => Promise<void>, options: PlanningWorldOptions = {}) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir, options));
    } finally {
      t.state.close();
    }
  });

const officeOf = (w: PlanningWorld) => w.office.officeId as never;
const viewOf = (w: PlanningWorld) => w.sessions.view(officeOf(w));

const chat = (w: PlanningWorld, text: string, context: ChatContext = DESK, thread?: RunId) =>
  w.sessions.chat(commandContext(w), {
    text,
    context,
    ...(thread === undefined ? {} : { thread }),
  });

/** Waits, moving the test clock on, until the model session waits for the maintainer. */
const waiting = (w: PlanningWorld) =>
  until(() => {
    w.t.clock.advance(1_000);
    return viewOf(w)?.state === "waiting";
  });

/** The text of every message written to the model session's stdin, in order. */
const written = (w: PlanningWorld): string[] =>
  w.sent.flatMap((ops) => {
    const text = ops.flatMap((op) => ("write" in op ? [op.write] : [])).join("");
    return text === ""
      ? []
      : [(JSON.parse(text) as { message: { content: string } }).message.content];
  });

const ended = (w: PlanningWorld) =>
  entriesAfter(w.office)
    .filter((entry) => entry.type === "planning.ended")
    .map((entry) => (entry.delta as { reason: string }).reason);

describe("the office chat (DIPO-523)", () => {
  it("opens a thread titled by the message when none is open", () =>
    withWorld(async (w) => {
      const opened = await chat(w, "Why does DIPO-15 wait on the merge?");
      expect(opened.result.outcome).toBe("opened");
      const thread = opened.result.thread as RunId;
      await until(() => viewOf(w)?.state === "waiting");
      expect(viewOf(w)).toMatchObject({
        run: thread,
        session: thread,
        kind: "plan",
        goal: "Why does DIPO-15 wait on the merge?",
        title: "Why does DIPO-15 wait on the merge?",
      });
      expect(readPlanningRecord(w.office, thread)[0]).toMatchObject({
        kind: "goal",
        subject: "plan",
        text: "Why does DIPO-15 wait on the merge?",
      });
      expect(w.plans[0]?.stdin[0]).toContain("goal: Why does DIPO-15 wait on the merge?");
    }));

  it("keeps the kind of a thread opened from the Roles room, and titles a long message by its first line", () =>
    withWorld(async (w) => {
      const text = `${"Which role should review the docs stories, and why ".repeat(3)}\nMore.`;
      await chat(w, text, { room: "roles" });
      expect(viewOf(w)).toMatchObject({ kind: "roles", goal: text, title: threadTitle(text) });
      expect(threadTitle(text)).toHaveLength(72);
      expect(threadTitle(text).endsWith("…")).toBe(true);
    }));

  it("never answers planning.open: the next message goes to the open thread, and /new opens another", () =>
    withWorld(async (w) => {
      const first = (await chat(w, "First topic")).result.thread as RunId;
      await waiting(w);
      const next = await chat(w, "And one more thing");
      expect(next.result).toEqual({ thread: first, outcome: "sent" });
      await waiting(w);
      expect(written(w).at(-1)).toContain("And one more thing");

      // `/new` with a text opens a thread titled by it; the first one's model session ends first.
      const other = await chat(w, "/new Second topic");
      expect(other.result.outcome).toBe("queued");
      expect(other.result.thread).not.toBe(first);
      await until(() => {
        w.t.clock.advance(1_000);
        return viewOf(w)?.session === other.result.thread;
      });
      expect(ended(w)).toEqual(["switched"]);
      expect(viewOf(w)?.title).toBe("Second topic");
      expect(w.sessions.liveRuns()).toHaveLength(1);
      // Both stay open: a message naming the first continues it from its record.
      await waiting(w);
      const back = await chat(w, "Back to the first", DESK, first);
      expect(back.result).toEqual({ thread: first, outcome: "queued" });
      await until(() => {
        w.t.clock.advance(1_000);
        return viewOf(w)?.session === first && viewOf(w)?.state === "waiting";
      });
      const fresh = JSON.parse(w.plans.at(-1)?.stdin[0] ?? "{}") as {
        message: { content: string };
      };
      expect(fresh.message.content).toContain("Back to the first");
      expect(viewOf(w)?.messages?.map((message) => message.text)).toEqual([
        "And one more thing",
        "Back to the first",
      ]);

      // A bare `/new`: the next message opens a thread.
      expect((await chat(w, "/new")).result).toEqual({ outcome: "new" });
      const third = await chat(w, "Third topic");
      expect(third.result.thread).not.toBe(first);
      await until(() => {
        w.t.clock.advance(1_000);
        return viewOf(w)?.title === "Third topic";
      });
    }));

  it("holds a message sent while the answer streams and sends it, with the others held, when the answer ends", () =>
    withWorld(async (w) => {
      const thread = (await chat(w, "Plan the export")).result.thread as RunId;
      await waiting(w);
      w.holdAnswers = true;
      expect((await chat(w, "Look at the CLI first.")).result.outcome).toBe("sent");
      expect(viewOf(w)?.state).toBe("working");
      const writes = written(w).length;

      expect((await chat(w, "Then the docs.")).result).toEqual({ thread, outcome: "queued" });
      expect((await chat(w, "And the tests.")).result.outcome).toBe("queued");
      expect(written(w)).toHaveLength(writes);
      expect(viewOf(w)?.queued?.map((item) => item.text)).toEqual([
        "Then the docs.",
        "And the tests.",
      ]);

      // The answer ends: both go as the next turn, one message, and the queue is empty.
      w.holdAnswers = false;
      w.release();
      await until(() => {
        w.t.clock.advance(1_000);
        return written(w).length === writes + 1;
      });
      expect(written(w).at(-1)).toContain("Then the docs.\n\nAnd the tests.");
      expect(viewOf(w)?.queued).toBeUndefined();
      // Each is its own message in the record.
      expect(viewOf(w)?.messages?.map((message) => message.text)).toEqual([
        "Look at the CLI first.",
        "Then the docs.",
        "And the tests.",
      ]);
    }));

  it("refuses a thread that is not open, and an /end with no thread", () =>
    withWorld(async (w) => {
      const none = await chat(w, "/end").catch((error: unknown) => error);
      expect((none as CommandError).error.code).toBe("planning.notOpen");
      const unknown = await chat(w, "Hello", DESK, RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E"))
        .then(() => null)
        .catch((error: unknown) => error);
      expect((unknown as CommandError).error.code).toBe("chat.threadUnknown");
    }));

  it("is parsed by code: /new and /end, with or without a text, and nothing else", () => {
    expect(chatCommandOf("/new")).toEqual({ name: "new", rest: "" });
    expect(chatCommandOf(" /new  Plan M6\nwith care ")).toEqual({
      name: "new",
      rest: "Plan M6\nwith care",
    });
    expect(chatCommandOf("/end")).toEqual({ name: "end", rest: "" });
    expect(chatCommandOf("/newer things")).toEqual({ name: null, rest: "/newer things" });
    expect(chatCommandOf("Use /end later")).toEqual({ name: null, rest: "Use /end later" });
  });
});

/** A lane that holds one filing per story entry, each with the gate line `gate`. */
function laneWith(gates: ReadonlyMap<string, string>): PlanningSessionsLane {
  return () =>
    ({
      filingsOf: (run: string, proposal: number): PlannedFiling[] => {
        const gate = [...gates.values()][proposal - 1];
        if (gate === undefined) return [];
        return [
          {
            kind: FILE_KIND,
            target: fileTargetOf(run, proposal, storyFieldsOf(STORY_PROPOSAL)),
            outcome: "applied",
            notice: gate,
            merged: false,
            gate,
          },
        ];
      },
    }) as unknown as PlanningLane;
}
type PlanningSessionsLane = NonNullable<PlanningWorldOptions["lane"]>;

/** Records the stories of `gates` as filed by the open thread, one proposal each. */
function filed(w: PlanningWorld, gates: ReadonlyMap<string, string>): void {
  const view = viewOf(w);
  const session = view?.session ?? "";
  w.office.immediate(() => {
    for (const [index, story] of [...gates.keys()].entries()) {
      addPlanningEntry(w.office, session, {
        kind: "story",
        run: view?.run ?? "",
        subject: story,
        proposal: index + 1,
        text: "filed",
        at: w.t.clock.now(),
      });
    }
  });
}

const GATES = new Map([
  ["DIPO-31", "DIPO-31 is Ready: the Ready gate passed it as filed"],
  ["DIPO-32", "DIPO-32 is Refined: R15: the story has no test plan; R2: no tier"],
]);

describe("closing a thread (DIPO-523)", () => {
  it("/end runs the Ready step and closes the thread, which keeps its record and opens no more", () =>
    withWorld(
      async (w) => {
        const thread = (await chat(w, "Plan the export")).result.thread as RunId;
        await waiting(w);
        filed(w, GATES);
        const closed = await chat(w, "/end");
        expect(closed.result).toEqual({
          thread,
          outcome: "closed",
          refined: [{ story: "DIPO-32", message: "R15: the story has no test plan" }],
        });
        w.t.clock.advance(1_000);
        await until(() => planningRun(w.office, thread)?.end_kind !== null);
        expect(ended(w)).toEqual(["maintainer"]);
        expect(readPlanningRecord(w.office, thread).at(-1)).toMatchObject({
          kind: "ended",
          text: "maintainer",
        });
        // The next message opens a new thread; the closed one is not continued.
        const next = await chat(w, "Something else");
        expect(next.result.outcome).toBe("opened");
        expect(next.result.thread).not.toBe(thread);
      },
      { lane: laneWith(GATES) },
    ));
});

describe("the planning commands, aliases for one release (DIPO-523)", () => {
  it("planning.start is /new with a kind and a goal, and planning.end is /end with its Ready step", () =>
    withWorld(
      async (w) => {
        const chatThread = (await chat(w, "A chat thread")).result.thread as RunId;
        await waiting(w);
        // planning.start while a thread is open opens another, as `/new` does: no planning.open.
        const startedPlan = w.sessions.start(commandContext(w), {
          kind: "refine",
          goal: "Sharpen the drafts",
        });
        await until(() => {
          w.t.clock.advance(1_000);
          return w.boxes.made.length === 2;
        });
        const plan = (await startedPlan).result;
        expect(plan.view).toMatchObject({
          kind: "refine",
          goal: "Sharpen the drafts",
          title: "Sharpen the drafts",
        });
        expect(plan.run).not.toBe(chatThread);
        await waiting(w);

        // planning.message goes the chat's way: held while the answer streams.
        w.holdAnswers = true;
        await w.sessions.message(commandContext(w), { text: "Start with DRAFT-1." });
        const held = await w.sessions.message(commandContext(w), { text: "Then DRAFT-2." });
        expect(held.result).toEqual({ run: plan.run, delivered: "next-turn" });
        expect(viewOf(w)?.queued?.map((item) => item.text)).toEqual(["Then DRAFT-2."]);
        w.holdAnswers = false;
        w.release();
        await waiting(w);
        await waiting(w);
        expect(written(w).at(-1)).toContain("Then DRAFT-2.");

        // planning.end is `/end`: the thread closes with its Ready step.
        filed(w, GATES);
        const end = await w.sessions.end(commandContext(w));
        expect(end.result).toEqual({
          run: plan.run,
          ended: "maintainer",
          refined: [{ story: "DIPO-32", message: "R15: the story has no test plan" }],
        });
        w.t.clock.advance(1_000);
        await until(() => planningRun(w.office, plan.run)?.end_kind !== null);
        expect(readPlanningRecord(w.office, plan.run).at(-1)).toMatchObject({
          kind: "ended",
          text: "maintainer",
        });
        // The chat thread is still open; planning.end closes it next, with no model session.
        const second = await w.sessions.end(commandContext(w));
        expect(second.result).toEqual({ run: chatThread, ended: "maintainer" });
        expect(readPlanningRecord(w.office, chatThread).at(-1)).toMatchObject({
          kind: "ended",
          run: chatThread,
          text: "maintainer",
        });
        const none = await w.sessions.end(commandContext(w)).catch((error: unknown) => error);
        expect((none as CommandError).error.code).toBe("planning.notOpen");
      },
      { lane: laneWith(GATES) },
    ));
});
