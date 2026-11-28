// The facts of the place a chat message is written from (DIPO-524, 0024), on a fixture-built test
// database with the scripted worker host: stored with each message, built by code per room, sent
// once per change of place, and followed by the proposal schemas; `/general` and `/here` drop and
// restore the item.

import { describe, expect, it } from "bun:test";

import { type ChatContext, type RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { readPlanningRecord } from "../../src/records/planning-record";
import { contextKey, proposalSchemaFor } from "../../src/run/chat-facts";
import { checkProposal } from "../../src/run/planning-proposals";
import { openTestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import {
  blocksOf,
  commandContext,
  planningWorld,
  type PlanningWorld,
  ROSTER_FILES,
  until,
} from "./planning-world";

const withWorld = (fn: (w: PlanningWorld) => Promise<void>) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir, { roleFiles: () => ROSTER_FILES }));
    } finally {
      t.state.close();
    }
  });

const viewOf = (w: PlanningWorld) => w.sessions.view(w.office.officeId as never);

const chat = (w: PlanningWorld, text: string, context: ChatContext) =>
  w.sessions.chat(commandContext(w), { text, context });

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

const QUEUE: ChatContext = { room: "queue", item: "TASK-1" };

describe("a message carries the facts of its place (DIPO-524)", () => {
  it("from the Queue on a Refined story, the first message carries its gate result and chain, and the record keeps the place", () =>
    withWorld(async (w) => {
      pass(w.t, w.office, [
        task("TASK-1", { title: "Add the CSV export", waitingOn: ["TASK-2"] }),
        task("TASK-2", { title: "Rename the setting" }),
      ]);
      const opened = await chat(w, "Why is this not Ready?", QUEUE);
      const thread = opened.result.thread as RunId;
      await waiting(w);
      const first = (JSON.parse(w.plans[0]?.stdin[0] ?? "{}") as { message: { content: string } })
        .message.content;
      expect(first).toContain('<context room="queue" item="TASK-1">');
      expect(first).toContain("state: Refined");
      expect(first).toContain("Ready gate: has not decided it");
      expect(first).toContain("chain: waits on TASK-2; unblocks nothing");
      const record = readPlanningRecord(w.office, thread);
      expect(record.find((entry) => entry.kind === "message")?.subject ?? null).toBe(null);
      // The goal is the first message; later messages keep their place in the record.
      await chat(w, "And TASK-2?", { room: "queue", item: "TASK-2" });
      await waiting(w);
      const later = readPlanningRecord(w.office, thread).filter(
        (entry) => entry.kind === "message",
      );
      expect(later.at(-1)?.subject).toBe(JSON.stringify({ room: "queue", item: "TASK-2" }));
      expect(written(w).at(-1)).toContain('<context room="queue" item="TASK-2">');
      expect(written(w).at(-1)).toContain("chain: waits on nothing; unblocks TASK-1");
    }));

  it("a second message from the same place adds no facts; a change of place does", () =>
    withWorld(async (w) => {
      pass(w.t, w.office, [task("TASK-1")]);
      await chat(w, "First", QUEUE);
      await waiting(w);
      await chat(w, "Second", QUEUE);
      await waiting(w);
      expect(written(w).at(-1)).toBe("Second");
      await chat(w, "Third", { room: "retro" });
      await waiting(w);
      expect(written(w).at(-1)).toContain('<context room="retro">');
      expect(written(w).at(-1)).toContain("Third");
      await chat(w, "Fourth", { room: "retro" });
      await waiting(w);
      expect(written(w).at(-1)).toBe("Fourth");
    }));

  it("builds facts for every room that has some, and none for the chat", () =>
    withWorld(async (w) => {
      pass(w.t, w.office, [task("TASK-1")]);
      await chat(w, "Start", { room: "desk" });
      await waiting(w);
      const rooms = ["floor", "queue", "run", "story", "retro", "roles", "background"] as const;
      for (const room of rooms) {
        await chat(w, `From ${room}`, { room, item: "TASK-1" });
        await waiting(w);
        expect(written(w).at(-1)).toContain(`<context room="${room}" item="TASK-1">`);
      }
      await chat(w, "From the chat", { room: "chat" });
      await waiting(w);
      expect(written(w).at(-1)).toBe("From the chat");
    }));
});

const kindsOf = (schema: Readonly<Record<string, unknown>>) =>
  (schema.oneOf as { properties: { kind: { const: string } } }[]).map(
    (alternative) => alternative.properties.kind.const,
  );

describe("the proposal schemas follow the place (DIPO-524)", () => {
  const SCHEMA = {
    oneOf: [
      { properties: { kind: { const: "story" } } },
      { properties: { kind: { const: "role" } } },
      { properties: { kind: { const: "role-remove" } } },
    ],
  };

  it("holds role proposals only for the Roles room and the others anywhere else", () => {
    expect(kindsOf(proposalSchemaFor({ room: "roles" }, SCHEMA))).toEqual(["role", "role-remove"]);
    expect(kindsOf(proposalSchemaFor({ room: "desk", item: "TASK-1" }, SCHEMA))).toEqual(["story"]);
  });

  it("sends the schema of the new place when the family changes, once", () =>
    withWorld(async (w) => {
      await chat(w, "Plan", { room: "desk" });
      await waiting(w);
      await chat(w, "Roles now", { room: "roles" });
      await waiting(w);
      expect(written(w).at(-1)).toContain("only role, role-edit and role-remove proposals");
      await chat(w, "More roles", { room: "roles" });
      await waiting(w);
      expect(written(w).at(-1)).toBe("More roles");
    }));

  it("refuses a role proposal outside the Roles context, naming the context", () => {
    const role = {
      kind: "role",
      name: "tester",
      purpose: "Writes the tests",
      instructions: "Test each criterion.",
      why: "Stories need a tester.",
    };
    const read = checkProposal(
      role,
      { files: ROSTER_FILES, openStories: () => [] },
      "plan",
      undefined,
      "the queue room on TASK-1",
    );
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.problems.join()).toContain(
      "this message came from the queue room on TASK-1",
    );
  });

  const role = {
    kind: "role",
    name: "tester",
    purpose: "Writes the tests",
    instructions: "Test each criterion.",
    why: "Stories need a tester.",
  };

  it("refuses it in the answer to a message from the Desk, naming the place", () =>
    withWorld(async (w) => {
      w.answerText = (n) => (n === 2 ? blocksOf(role) : "Noted.");
      await chat(w, "Plan", { room: "desk" });
      await waiting(w);
      await chat(w, "Add a tester role", { room: "desk" });
      await until(() => {
        w.t.clock.advance(1_000);
        return (viewOf(w)?.refusals?.length ?? 0) > 0;
      });
      expect(viewOf(w)?.refusals?.[0]?.problems.join()).toContain("the desk room");
      expect(viewOf(w)?.proposals ?? []).toHaveLength(0);
    }));

  it("takes it in the answer to a message from the Roles room, even in a thread opened on the Desk", () =>
    withWorld(async (w) => {
      w.answerText = (n) => (n === 2 ? blocksOf(role) : "Noted.");
      await chat(w, "Plan", { room: "desk" });
      await waiting(w);
      await chat(w, "Add a tester role", { room: "roles" });
      await until(() => {
        w.t.clock.advance(1_000);
        return (viewOf(w)?.proposals?.length ?? 0) > 0;
      });
      expect(viewOf(w)?.proposals?.map((item) => item.proposal.kind)).toEqual(["role"]);
      expect(viewOf(w)?.refusals ?? []).toHaveLength(0);
    }));
});

describe("/general and /here (DIPO-524)", () => {
  it("/general drops the item from the next messages and /here brings it back", () =>
    withWorld(async (w) => {
      pass(w.t, w.office, [task("TASK-1")]);
      await chat(w, "Look", QUEUE);
      await waiting(w);
      const dropped = await chat(w, "/general", QUEUE);
      expect(dropped.result).toEqual({ outcome: "noted", context: { room: "queue" } });
      await chat(w, "Anything in the Queue?", QUEUE);
      await waiting(w);
      expect(written(w).at(-1)).toContain('<context room="queue">');
      expect(written(w).at(-1)).not.toContain("item=");
      expect(written(w).at(-1)).not.toContain("chain:");
      const back = await chat(w, "/here", QUEUE);
      expect(back.result).toEqual({ outcome: "noted", context: QUEUE });
      await chat(w, "Now this story", QUEUE);
      await waiting(w);
      expect(written(w).at(-1)).toContain('<context room="queue" item="TASK-1">');
    }));

  it("/general with a text sends it without the item", () =>
    withWorld(async (w) => {
      await chat(w, "Look", QUEUE);
      await waiting(w);
      await chat(w, "/general What is the Queue for?", QUEUE);
      await waiting(w);
      expect(written(w).at(-1)).toContain("What is the Queue for?");
      expect(written(w).at(-1)).not.toContain("/general");
      expect(contextKey({ room: "queue" })).toBe("queue");
    }));
});
