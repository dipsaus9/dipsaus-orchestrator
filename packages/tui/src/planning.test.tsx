// The planning view (DIPO-449): start a session with a kind and a goal, write a multi-line message
// (Enter adds a line, Ctrl-S sends), read the streamed answer with the live spend, end the session;
// and reopening the TUI shows the open session again, with its stored answers and the notice of a
// fresh Claude session. Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, PlanningView } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P01";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function planningView(extra: Partial<PlanningView> = {}): PlanningView {
  return {
    run: RUN,
    kind: "plan",
    goal: "Plan the export feature",
    model: "claude-opus-5-5",
    state: "waiting",
    turns: 1,
    usage: {
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheCreateTokens: 1_000,
      cacheReadTokens: 40_000,
      turns: 1,
      elapsedMs: 5_000,
    },
    startedAt: "2026-10-14T10:00:00.000Z",
    ...extra,
  } as PlanningView;
}

function officeEvent(seq: number, type: string, data: unknown): Event {
  return { cursor: { stream: STREAM, seq }, at: "2026-10-14T10:05:00.000Z", type, data } as Event;
}

function golden() {
  const snapshot = goldenSnapshots.get(OFFICES.dipsaus);
  if (snapshot === undefined) throw new Error("no dipsaus snapshot in the golden log");
  return snapshot;
}

async function open(options: Parameters<typeof mount>[0] = { columns: 120, rows: 30 }) {
  const view = await mount(options);
  mounted.push(view.ui);
  await view.ui.waitFor("dipsaus-orchestrator");
  return view;
}

describe("the planning view", () => {
  it("starts a session, sends a multi-line message, streams the answer with its spend and ends it", async () => {
    const { ui, session } = await open();
    await ui.press("5");
    const form = await ui.waitFor("no open planning session");
    expect(form).toContain("[plan]  refine  triage");
    expect(form).toContain("[Ctrl-S] start");

    await ui.press("tab");
    await ui.waitFor("plan  [refine]  triage");
    await ui.press("tab");
    await ui.press("tab");
    await ui.waitFor("[plan]");
    await ui.press("Plan the export");
    await ui.press("enter");
    await ui.press("and its tests");
    await ui.waitFor("> Plan the export");
    session.commandReply = (name) =>
      name === "planning.start"
        ? {
            ok: true,
            result: { run: RUN, view: planningView({ state: "starting", turns: 0 }) },
            changed: true,
          }
        : undefined;
    await ui.press("ctrl-s");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.start"); i++) {
      await Bun.sleep(5);
    }
    const start = session.commands.find((c) => c.name === "planning.start");
    expect(start?.args).toEqual({ kind: "plan", goal: "Plan the export\nand its tests" });

    // The engine's events: the session starts, an answer streams in, the turn ends with its spend.
    const stream = session.active(STREAM);
    stream?.options.onEvent(
      officeEvent(8, "planning.started", {
        run: RUN,
        view: planningView({ state: "working", turns: 0, goal: "Plan the export\nand its tests" }),
      }),
    );
    const working = await ui.waitFor("Planning · plan · working");
    expect(working).toContain("goal: Plan the export and its tests");
    session.output.set(`${RUN}:worker`, "First idea: split it in two.\n");
    stream?.options.onEvent(
      officeEvent(9, "planning.output", {
        run: RUN,
        from: 0,
        to: 29,
        text: "First idea: split it in two.\n",
        view: planningView({ state: "working", turns: 0 }),
      }),
    );
    await ui.waitFor("First idea: split it in two.");
    stream?.options.onEvent(
      officeEvent(10, "planning.updated", { run: RUN, view: planningView() }),
    );
    const done = await ui.waitFor("1 answer");
    expect(done).toContain("spend: in 12k · out 3k · cache write 1k · cache read 40k");
    expect(done).toContain("[Ctrl-E] end session");

    // A message of two lines: Enter adds a line, Ctrl-S sends.
    await ui.press("Why two?");
    await ui.press("enter");
    await ui.press("And the order?");
    await ui.press("ctrl-s");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.message"); i++) {
      await Bun.sleep(5);
    }
    const message = session.commands.find((c) => c.name === "planning.message");
    expect(message?.args).toEqual({ text: "Why two?\nAnd the order?" });
    const asked = await ui.waitFor("you> And the order?");
    expect(asked).toContain("you> Why two?");

    // Ending asks first.
    await ui.press("ctrl-e");
    await ui.waitFor("End the planning session? [y/N]");
    await ui.press("n");
    await ui.waitFor("the session stays open");
    await ui.press("ctrl-e");
    await ui.press("y");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.end"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.some((c) => c.name === "planning.end")).toBe(true);
    stream?.options.onEvent(
      officeEvent(11, "planning.ended", {
        run: RUN,
        reason: "maintainer",
        view: planningView({ state: "ended", ended: "maintainer" }),
      }),
    );
    await ui.waitFor("no open planning session");
  });

  it("shows the open session again when the TUI opens, with its answers, and says it continued in a fresh session", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({ turns: 2, continuedAt: "2026-10-14T09:30:00.000Z" }),
        },
      ],
    ]);
    const output = new Map([[`${RUN}:worker`, "Earlier answer one.\nEarlier answer two.\n"]]);
    const { ui, session } = await open({ columns: 120, rows: 30, snapshots, output });
    await ui.press("5");
    const frame = await ui.waitFor("Earlier answer two.");
    expect(frame).toContain("Planning · plan · waiting · 2 answers");
    expect(frame).toContain("goal: Plan the export feature");
    expect(frame).toContain("continued in a fresh model session at");
    expect(frame).toContain("Earlier answer one.");

    // Continue it: a message goes to the open session, not to a new start.
    await ui.press("And a third?");
    await ui.press("ctrl-s");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.message"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.some((c) => c.name === "planning.start")).toBe(false);
    expect(session.commands.find((c) => c.name === "planning.message")?.args).toEqual({
      text: "And a third?",
    });
  });

  it("leaves the other views and keys as they were: Esc returns to the overview", async () => {
    const { ui } = await open();
    await ui.press("5");
    await ui.waitFor("no open planning session");
    // q is text in the planning view, not quit.
    await ui.press("q");
    await ui.waitFor("> q");
    await ui.press("escape");
    const home = await ui.waitFor("RUNNING");
    expect(home).not.toContain("[5] plan");
    await ui.press("2");
    await ui.waitFor("[1] overview");
  });
});
