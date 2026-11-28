// The chat's action cards in the TUI (DIPO-525): `c` sends the matching command as the
// maintainer's own with origin `chat`, the card turns into its pending, sent or failed line in
// place with ^R to retry, and a command card's drop and discard open the existing prompts.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  ChatCardView,
  OfficeId,
  PlanningView,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import { Box } from "ink";
import { createElement } from "react";

import { cardRequest, cardRows, dropTarget, retryKind, type CardSend } from "./chat-cards";
import { type Span, SpanLine } from "./spans";
import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { render } from "../test/support/harness";
import { expectScreen } from "../test/support/mock-screens";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P01";
const AT = "2026-10-14T10:04:00.000Z";
const REQUEST = "01J9ZK5Q8W3V4X6Y7Z8A9B0P01" as RequestId;

const steer: ChatCardView = {
  n: 1,
  card: {
    kind: "steer",
    story: "DIPO-512",
    text: "Stop changing the wait. Clear the pid file on acquire.",
  },
  target: "DIPO-512",
  consequence: "arrives at its next turn",
  at: AT,
};
const drop: ChatCardView = {
  n: 2,
  card: {
    kind: "command",
    line: "dipo drop DIPO-116",
    effect: "Archives DIPO-116 and releases its claim.",
  },
  target: "dipo drop DIPO-116",
  consequence: "",
  at: AT,
};

describe("what a card sends", () => {
  it("sends each of the four kinds as the maintainer's own command with origin chat", () => {
    const office = OFFICES.dipsaus as OfficeId;
    expect(cardRequest(steer.card, office, REQUEST)).toEqual({
      office,
      command: "work.steer",
      args: { story: "DIPO-512", text: "Stop changing the wait. Clear the pid file on acquire." },
      requestId: REQUEST,
      confirmed: false,
      origin: "chat",
    });
    expect(
      cardRequest(
        { kind: "answer", question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0P01" as never, text: "Yes" },
        office,
        REQUEST,
      )?.command,
    ).toBe("work.answer");
    expect(cardRequest({ kind: "resume", story: "DIPO-9" }, office, REQUEST)?.args).toEqual({
      story: "DIPO-9",
    });
    expect(cardRequest({ kind: "ready", stories: ["DIPO-9"] }, office, REQUEST)?.command).toBe(
      "story.ready",
    );
    // The text the maintainer edited is what is sent.
    expect(cardRequest(steer.card, office, REQUEST, "Do it.")?.args).toEqual({
      story: "DIPO-512",
      text: "Do it.",
    });
  });

  it("sends nothing for a command card, which only names a line to copy", () => {
    expect(cardRequest(drop.card, OFFICES.dipsaus as OfficeId, REQUEST)).toBeNull();
    expect(dropTarget(drop.card)).toEqual({ action: "drop", story: "DIPO-116" });
    expect(
      dropTarget({ kind: "command", line: "dipo discard dipo-7 --note x", effect: "x" }),
    ).toEqual({
      action: "discard",
      story: "DIPO-7",
    });
    expect(dropTarget({ kind: "command", line: "dipo ready DIPO-7", effect: "x" })).toBeNull();
  });

  it("retries a failed card: the same request, or a steer as a resume note", () => {
    const request = cardRequest(steer.card, OFFICES.dipsaus as OfficeId, REQUEST)!;
    const failed = (code: string, retryable: boolean): CardSend => ({
      status: "failed",
      request,
      error: { code, message: "no", retryable },
      at: "11:03",
    });
    expect(retryKind(steer.card, failed("story.notRunning", false))).toBe("resume");
    expect(retryKind(steer.card, failed("engine.recovering", true))).toBe("same");
    expect(retryKind(steer.card, failed("args.invalid", false))).toBeNull();
    expect(retryKind(steer.card, { status: "sent", request, at: "11:03", words: "x" })).toBeNull();
  });
});

function view(cards: ChatCardView[]): PlanningView {
  return {
    run: RUN,
    kind: "plan",
    goal: "Why does DIPO-512 loop?",
    model: "claude-opus-5-5",
    state: "waiting",
    turns: 1,
    usage: {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      turns: 1,
      elapsedMs: 1_000,
    },
    startedAt: "2026-10-14T10:00:00.000Z",
    cards,
  } as unknown as PlanningView;
}

async function open(cards: ChatCardView[], waitFor = "◆ steer") {
  const snapshot = { ...goldenSnapshots.get(OFFICES.dipsaus)!, planning: view(cards) };
  const ui = await mount({
    columns: 120,
    rows: 30,
    snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
  });
  mounted.push(ui.ui);
  await ui.ui.waitFor("dipsaus-orchestrator");
  await ui.ui.press("5");
  await ui.ui.waitFor(waitFor);
  return ui;
}

const sentOf = async (session: { commands: { name: string; args: unknown }[] }, name: string) => {
  for (let i = 0; i < 100 && !session.commands.some((c) => c.name === name); i++)
    await Bun.sleep(5);
  return session.commands.filter((c) => c.name === name);
};

describe("the cards of the chat view", () => {
  it("sends nothing until c, then sends work.steer with origin chat and shows it sent in place", async () => {
    const { ui, session } = await open([steer]);
    expect(ui.frame()).toContain("◆ steer · DIPO-512 · arrives at its next turn");
    await Bun.sleep(50);
    expect(session.commands.filter((c) => c.name === "work.steer")).toEqual([]);

    await ui.press("up");
    const focused = await ui.waitFor("▌ ◆ steer");
    expect(focused).toContain("c send   e edit   x drop   esc to the input");
    session.commandReply = (name) =>
      name === "work.steer"
        ? { ok: true, result: { run: RUN, delivered: "next-turn" }, changed: true }
        : undefined;
    await ui.press("c");
    const [steered] = await sentOf(session, "work.steer");
    expect(steered?.args).toEqual({
      story: "DIPO-512",
      text: "Stop changing the wait. Clear the pid file on acquire.",
    });
    expect(
      (steered as { options?: { origin?: string; confirmed?: boolean } }).options,
    ).toMatchObject({
      origin: "chat",
      confirmed: false,
    });
    const frame = await ui.waitFor("✓ sent");
    expect(frame).toContain("steer · DIPO-512 · delivered next turn");
    expect(frame).not.toContain("◆ steer");
  });

  it("shows a failed card with ^R, and ^R sends the same request again", async () => {
    const { ui, session } = await open([steer]);
    session.commandReply = (name) =>
      name === "work.steer"
        ? {
            ok: false,
            error: {
              code: "engine.recovering",
              message: "the daemon is recovering",
              retryable: true,
            },
          }
        : undefined;
    await ui.press("up");
    await ui.waitFor("▌ ◆ steer");
    await ui.press("c");
    const failed = await ui.waitFor("steer not sent: the daemon is recovering");
    expect(failed).toContain("^R retry");
    session.commandReply = (name) =>
      name === "work.steer"
        ? { ok: true, result: { run: RUN, delivered: "next-turn" }, changed: true }
        : undefined;
    await ui.press("ctrl-r");
    await ui.waitFor("✓ sent");
    const sent = await sentOf(session, "work.steer");
    expect(sent).toHaveLength(2);
    const ids = sent.map((c) => (c as { options?: { requestId?: string } }).options?.requestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("offers a steer that found its story parked as a resume note", async () => {
    const { ui, session } = await open([steer]);
    session.commandReply = (name) =>
      name === "work.steer"
        ? {
            ok: false,
            error: {
              code: "story.notRunning",
              message: "DIPO-512 is no longer running",
              retryable: false,
            },
          }
        : undefined;
    await ui.press("up");
    await ui.press("c");
    const failed = await ui.waitFor("^R retry as a resume note");
    expect(failed).toContain("steer not sent: DIPO-512 is no longer running");
    session.commandReply = () => undefined;
    await ui.press("ctrl-r");
    const [resumed] = await sentOf(session, "work.resume");
    expect(resumed?.args).toEqual({
      story: "DIPO-512",
      note: "Stop changing the wait. Clear the pid file on acquire.",
    });
    expect((resumed as { options?: { origin?: string } }).options?.origin).toBe("chat");
  });

  it("copies a command card with c and opens the existing drop prompt with X, sending nothing itself", async () => {
    const { ui, session } = await open([drop], "◆ command");
    await ui.press("up");
    const focused = await ui.waitFor("▌ ◆ command · dipo drop DIPO-116");
    expect(focused).toContain("c copy   X drop here (asks first)   esc to the input");
    await ui.press("c");
    await ui.waitFor("copied: dipo drop DIPO-116");
    expect(session.commands.filter((c) => c.name === "story.drop")).toEqual([]);

    await ui.press("X");
    await ui.waitFor("drop DIPO-116");
    await Bun.sleep(50);
    // The prompt asks first: no drop was sent.
    expect(session.commands.filter((c) => c.name === "story.drop")).toEqual([]);
  });

  it("drops a card from view with x without sending anything", async () => {
    const { ui, session } = await open([steer]);
    await ui.press("up");
    await ui.waitFor("▌ ◆ steer");
    await ui.press("x");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("◆ steer");
    expect(session.commands.filter((c) => c.name === "work.steer")).toEqual([]);
  });

  it("edits a card's text with e before it is sent", async () => {
    const { ui, session } = await open([steer]);
    await ui.press("up");
    await ui.waitFor("▌ ◆ steer");
    await ui.press("e");
    await ui.waitFor("save card 1");
    for (let i = 0; i < 60; i++) await ui.press("backspace");
    for (const ch of "Use the old pid file.") await ui.press(ch);
    await ui.press("enter");
    await ui.waitFor("▌ ◆ steer");
    await ui.press("c");
    const [steered] = await sentOf(session, "work.steer");
    expect(steered?.args).toEqual({ story: "DIPO-512", text: "Use the old pid file." });
  });
});

describe("the card lines of screens/07-states.txt (DIPO-525)", () => {
  it("matches the mock for a card after c: pending, sent and failed, in place", async () => {
    const request = cardRequest(steer.card, OFFICES.dipsaus as OfficeId, REQUEST)!;
    const sends: CardSend[] = [
      { status: "sending", request },
      { status: "sent", request, at: "11:03", words: "delivered next turn" },
      {
        status: "failed",
        request,
        error: {
          code: "story.notRunning",
          message: "DIPO-512 is no longer running (parked 11:03)",
          retryable: false,
        },
        at: "11:03",
      },
    ];
    const ui = render(
      createElement(
        Box,
        { flexDirection: "column" },
        ...sends.map((send, i) =>
          createElement(SpanLine, {
            key: i,
            display: { color: true, ascii: false },
            spans: cardRows(steer, {
              focused: false,
              width: 100,
              gutter: 1,
              gutterInside: true,
              ascii: false,
              send,
            })[0]!,
          }),
        ),
      ),
      { columns: 112, rows: 3 },
    );
    await Bun.sleep(30);
    expectScreen(ui, "07-states.txt", "An action card after c");
    await ui.unmount();
  });
});

/** The cells of one focused card, `rows` of a 30-row screen, as the dock or the conversation draws them. */
async function cardScreen(
  columns: number,
  at: number,
  card: ChatCardView,
  lead: Span[],
  layout: { width: number; gutter: number; gutterInside: boolean },
) {
  const rows = cardRows(card, { focused: true, ascii: false, ...layout });
  const ui = render(
    createElement(
      Box,
      { flexDirection: "column" },
      ...Array.from({ length: 30 }, (_, index) =>
        createElement(SpanLine, {
          key: index,
          display: { color: true, ascii: false },
          spans: rows[index + 1 - at] === undefined ? [] : [...lead, ...rows[index + 1 - at]!],
        }),
      ),
    ),
    { columns, rows: 30 },
  );
  await Bun.sleep(30);
  return ui;
}

describe("the focused cards of the dock mocks (DIPO-525)", () => {
  it("draws the steer card of 05-run-with-dock-wide.txt cell for cell, beside the room", async () => {
    const stuck: ChatCardView = {
      ...steer,
      card: {
        kind: "steer",
        story: "DIPO-512",
        text: "Stop changing the wait. A restart reads the old pid file at lock.ts:97; clear it on acquire and keep the test at lock.test.ts:88 as it is.",
      },
    };
    // The room keeps 96 columns and the dock's rule `│`; the card has the 53 columns after two spaces.
    const ui = await cardScreen(
      152,
      13,
      stuck,
      [{ text: " ".repeat(96) }, { text: "│", role: "faint" }],
      { width: 51, gutter: 2, gutterInside: false },
    );
    expectScreen(ui, "05-run-with-dock-wide.txt", "C1 Run with the chat docked on the right");
    await ui.unmount();
  });

  it("draws the command card of 01-queue-with-dock.txt cell for cell, in the conversation", async () => {
    const ui = await cardScreen(
      112,
      22,
      {
        ...drop,
        card: {
          kind: "command",
          line: "dipo drop DIPO-116",
          effect:
            "Archives DIPO-116 and releases its claim. It has no branch or PR, so nothing is lost.",
        },
      },
      [],
      { width: 110, gutter: 1, gutterInside: true },
    );
    expectScreen(ui, "01-queue-with-dock.txt", "C1 Queue with the chat docked");
    await ui.unmount();
  });
});
