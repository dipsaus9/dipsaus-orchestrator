// The action cards of a chat answer (DIPO-525): the five kinds are read against the contract's
// schema and the office's state, an invalid block is refused to the session with its problems, and a
// card that would drop or discard can only be a command card.

import { describe, expect, it } from "bun:test";

import { ChatCard, PlanningView } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { AUTO_REFUSALS_MAX } from "../../src/run/planning-proposals";
import {
  cardRefusalMessage,
  checkCard,
  CARD_BLOCK_MAX_CHARS,
  type CardFacts,
  readCards,
} from "../../src/run/chat-cards";
import { openTestState } from "../commands/helpers";
import { commandContext, planningWorld, type PlanningWorld, until } from "./planning-world";

const QUESTION = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0P01";

const STORIES: Record<string, string> = {
  "DIPO-512": "In Progress",
  "DIPO-300": "Parked",
  "DIPO-116": "Refined",
  "DIPO-9": "Done",
};

const facts: CardFacts = {
  story: (id) => {
    const lifecycle = STORIES[id.toUpperCase()];
    return lifecycle === undefined ? null : { id: id.toUpperCase(), lifecycle };
  },
  question: (id) => (id === QUESTION ? { story: "DIPO-300" } : null),
};

const block = (value: unknown) => `\`\`\`dipo-card\n${JSON.stringify(value)}\n\`\`\``;

const problemsOf = (value: unknown): string =>
  JSON.stringify((checkCard(value, facts) as { problems?: string[] }).problems ?? []);

describe("the cards of an answer (DIPO-525)", () => {
  it("reads each of the five kinds with its target and consequence", () => {
    const steer = checkCard(
      { kind: "steer", story: "DIPO-512", text: "Clear the pid file." },
      facts,
    );
    expect(steer).toMatchObject({
      ok: true,
      target: "DIPO-512",
      consequence: "arrives at its next turn",
    });
    expect(checkCard({ kind: "answer", question: QUESTION, text: "Yes." }, facts)).toMatchObject({
      ok: true,
      target: "DIPO-300",
    });
    expect(checkCard({ kind: "resume", story: "DIPO-300" }, facts)).toMatchObject({
      ok: true,
      consequence: "resumes it",
    });
    expect(checkCard({ kind: "ready", stories: ["DIPO-116"] }, facts)).toMatchObject({
      ok: true,
      target: "DIPO-116",
    });
    expect(
      checkCard({ kind: "command", line: "dipo drop DIPO-116", effect: "Archives it." }, facts),
    ).toMatchObject({ ok: true, target: "dipo drop DIPO-116", consequence: "" });
  });

  it("refuses a steer card for a story that is not running, with a message to the session", () => {
    expect(problemsOf({ kind: "steer", story: "DIPO-300", text: "Go on." })).toContain(
      "DIPO-300 is Parked, not running",
    );
    expect(problemsOf({ kind: "steer", story: "DIPO-9", text: "Go on." })).toContain("not running");
    expect(problemsOf({ kind: "steer", story: "DIPO-77", text: "Go on." })).toContain("no story");
    const read = readCards(block({ kind: "steer", story: "DIPO-300", text: "Go on." }), facts);
    const message = cardRefusalMessage(read.flatMap((item) => (item.ok ? [] : [item.problems])));
    expect(message).toStartWith("[dipo] dipo refused a card block of your last answer");
    expect(message).toContain("DIPO-300 is Parked");
  });

  it("refuses an answer, a resume and a ready card the office's state does not fit", () => {
    expect(
      problemsOf({ kind: "answer", question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0P02", text: "x" }),
    ).toContain("is not open");
    expect(problemsOf({ kind: "resume", story: "DIPO-512" })).toContain("not parked");
    expect(problemsOf({ kind: "ready", stories: ["DIPO-116", "DIPO-9"] })).toContain(
      "only a Refined story goes Ready",
    );
  });

  it("lets a card that would drop or discard be a command card only", () => {
    for (const kind of ["drop", "discard"]) {
      const problems = problemsOf({ kind, story: "DIPO-116" });
      expect(problems).toContain(`a \`${kind}\` card does not exist`);
      expect(problems).toContain("command");
    }
    // No other kind takes a drop or discard: the schema holds no field for it.
    expect(
      ChatCard.safeParse({ kind: "steer", story: "DIPO-512", text: "x", drop: true }).success,
    ).toBe(false);
    for (const line of ["dipo drop DIPO-116", "dipo discard DIPO-116"]) {
      expect(checkCard({ kind: "command", line, effect: "Removes it." }, facts).ok).toBe(true);
    }
  });

  it("holds a command line to one plain `dipo` command", () => {
    for (const line of [
      "rm -rf /",
      "dipo drop DIPO-1; rm -rf /",
      "dipo drop DIPO-1 && echo",
      "dipo drop $(whoami)",
      "dipo drop `x`",
      "dipo drop DIPO-1 > /tmp/x",
      "dipo drop DIPO-1 | cat",
      "dipodrop DIPO-1",
    ]) {
      expect(checkCard({ kind: "command", line, effect: "x" }, facts).ok).toBe(false);
    }
    expect(
      checkCard({ kind: "command", line: "dipo drop DIPO-1\nrm x", effect: "x" }, facts).ok,
    ).toBe(false);
  });

  it("refuses JSON that does not parse, an unclosed block, a long block and an unknown key", () => {
    expect(readCards("```dipo-card\nnot json\n```", facts)[0]?.ok).toBe(false);
    expect(readCards("```dipo-card\n{}", facts)[0]).toMatchObject({ ok: false });
    expect(
      readCards(`\`\`\`dipo-card\n${"x".repeat(CARD_BLOCK_MAX_CHARS + 1)}\n\`\`\``, facts)[0]?.ok,
    ).toBe(false);
    expect(problemsOf({ kind: "resume", story: "DIPO-300", extra: 1 })).toContain("extra");
  });
});

const withWorld = (fn: (w: PlanningWorld) => Promise<void>) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(planningWorld(t, dir, { contextTokens: 100_000 }));
    } finally {
      t.state.close();
    }
  });

const viewOf = (w: PlanningWorld): PlanningView | null =>
  w.sessions.view(w.office.officeId as never);
const messagesOf = (w: PlanningWorld): string[] =>
  w.sent.flatMap((ops) =>
    ops.flatMap((op) => ("write" in op && typeof op.write === "string" ? [op.write] : [])),
  );

describe("a chat session's cards (DIPO-525)", () => {
  it("shows a valid card in the view", () =>
    withWorld(async (w) => {
      w.answerText = () =>
        `Copy this.\n\n${block({ kind: "command", line: "dipo drop DIPO-116", effect: "Archives it." })}`;
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Drafts" });
      await until(() => viewOf(w)?.state === "waiting");
      const view = PlanningView.parse(viewOf(w));
      expect(view.cards).toHaveLength(1);
      expect(view.cards?.[0]).toMatchObject({ n: 1, target: "dipo drop DIPO-116" });
    }));

  it("refuses a card for a story the office does not have, to the session", () =>
    withWorld(async (w) => {
      w.answerText = () => block({ kind: "steer", story: "DIPO-512", text: "Go on." });
      await w.sessions.start(commandContext(w), { kind: "plan", goal: "Drafts" });
      await until(() => messagesOf(w).length === 1);
      expect(messagesOf(w)[0]).toContain("[dipo] dipo refused a card block of your last answer");
      expect(messagesOf(w)[0]).toContain("this office has no story DIPO-512");
      w.t.clock.advance(1_000);
      await until(() => viewOf(w)?.turns === 2 && viewOf(w)?.state === "waiting");
      expect(viewOf(w)?.cards).toBeUndefined();
      expect(AUTO_REFUSALS_MAX).toBeGreaterThan(0);
    }));
});
