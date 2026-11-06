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

/** A filed story proposal of the planning view (DIPO-451). */
const filed = (n: number, title: string, story: string) => ({
  ...proposal(n, title, "M"),
  state: "filed",
  stories: [story],
});

/** An open story proposal of the planning view (DIPO-450). */
const proposal = (n: number, title: string, tier: "S" | "M") => ({
  n,
  proposal: {
    kind: "story",
    title,
    type: "feature",
    milestone: "m-3",
    tier,
    storyLine:
      "As maintainer I want to export the stories as a CSV file so that I can share the backlog with people outside dipo.",
    criteria: ["The export writes one CSV row per active story"],
    references: ["packages/cli/src/export-command.ts"],
    testPlan: { entries: [{ kind: "automated", check: "(unit) one CSV row per story" }] },
    why: `Why ${title}: the maintainer asked for it.`,
  },
  state: "open",
  at: "2026-10-14T10:04:00.000Z",
});

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

  it("shows each proposal with its tier and why and the latest refusal, and confirms, edits and declines by command (DIPO-450)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [proposal(1, "Export as CSV", "M"), proposal(2, "Export as XML", "S")],
            refusals: [{ at: "2026-10-14T10:03:00.000Z", problems: ["tier: Invalid option"] }],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui, session } = await open({ columns: 140, rows: 34, snapshots });
    await ui.press("5");
    const frame = await ui.waitFor("#2 story [S] Export as XML");
    expect(frame).toContain("proposals · 2 · 2 open");
    expect(frame).toContain("#1 story [M] Export as CSV · open");
    expect(frame).toContain("why: Why Export as XML: the maintainer asked for it.");
    expect(frame).toContain("▌ #2");
    expect(frame).toContain("refused a proposal at");
    expect(frame).toContain("tier: Invalid option");
    expect(frame).toContain("[Ctrl-Y] confirm");

    const sent = async (name: string) => {
      for (let i = 0; i < 100 && !session.commands.some((c) => c.name === name); i++) {
        await Bun.sleep(5);
      }
      return session.commands.find((c) => c.name === name);
    };

    // Decline the selected (the latest), then select the first and confirm it.
    await ui.press("ctrl-d");
    expect((await sent("planning.decline"))?.args).toEqual({ proposal: 2 });
    await ui.press("up");
    await ui.waitFor("▌ #1");
    session.commandReply = (name) =>
      name === "planning.confirm"
        ? {
            ok: true,
            result: { run: RUN, proposal: 1, state: "filed", stories: ["DIPO-31"] },
            changed: true,
          }
        : undefined;
    await ui.press("ctrl-y");
    expect((await sent("planning.confirm"))?.args).toEqual({ proposal: 1 });
    await ui.waitFor("proposal 1 confirmed: DIPO-31");

    // Edit: the proposal goes into the input as a form, and Ctrl-S sends it as planning.edit.
    session.commandReply = () => undefined;
    await ui.press("ctrl-r");
    const editing = await ui.waitFor("editing proposal 1:");
    expect(editing).toContain("tier: M");
    expect(editing).toContain("[Ctrl-S] save proposal 1");
    const why = "why: Why Export as CSV: the maintainer asked for it.";
    for (let i = 0; i < why.length; i++) await ui.press("backspace");
    await ui.press("why: Shorter why.");
    await ui.press("ctrl-s");
    const edit = await sent("planning.edit");
    expect(edit?.args).toMatchObject({
      proposal: 1,
      edited: { kind: "story", title: "Export as CSV", tier: "M", why: "Shorter why." },
    });
    await ui.waitFor("proposal 1 edited");
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
  });

  it("sets the stories left in the Ready form Ready and lists what the gate refused (DIPO-451)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [filed(1, "Export as CSV", "DIPO-31"), filed(2, "Export as XML", "DIPO-32")],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui, session } = await open({ columns: 140, rows: 40, snapshots });
    await ui.press("5");
    await ui.waitFor("#2 story [M] Export as XML");
    await ui.press("ctrl-g");
    const form = await ui.waitFor("setting stories Ready:");
    expect(form).toContain("DIPO-31 story [M] Export as CSV");
    expect(form).toContain("DIPO-32 story [M] Export as XML");
    // Drop the second story's line: only DIPO-31 is chosen.
    const line = "DIPO-32 story [M] Export as XML";
    for (let i = 0; i < line.length + 1; i++) await ui.press("backspace");
    session.commandReply = (name) =>
      name === "planning.ready"
        ? {
            ok: true,
            result: { run: RUN, queued: ["DIPO-31"], refused: [] },
            changed: true,
          }
        : undefined;
    await ui.press("ctrl-s");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.ready"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.find((c) => c.name === "planning.ready")?.args).toEqual({
      stories: ["DIPO-31"],
    });
    await ui.waitFor("DIPO-31 set Ready");
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
  });

  it("shows the gate's messages for a story that stays Refined (DIPO-451)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            ready: [
              {
                story: "DIPO-32",
                state: "refused",
                messages: ["R08: no acceptance criteria"],
                at: "2026-10-14T10:06:00.000Z",
              },
              { story: "DIPO-31", state: "set", at: "2026-10-14T10:06:00.000Z" },
            ],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui } = await open({ columns: 140, rows: 34, snapshots });
    await ui.press("5");
    const frame = await ui.waitFor("ready DIPO-32: refused");
    expect(frame).toContain("stays as it is: R08: no acceptance criteria");
    expect(frame).toContain("ready DIPO-31: set");
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
