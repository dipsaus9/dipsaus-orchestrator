// The planning view (DIPO-449): start a session with a kind and a goal, write a multi-line message
// (Shift+Enter adds a line, Enter sends), read the streamed answer with the live spend, end the session;
// and reopening the TUI shows the open session again, with its stored answers and the notice of a
// fresh Claude session. Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, LaneProgress, PlanningView, RunId } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mockRows } from "../test/support/mock-screens";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P01" as RunId;
const RUN2 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P02" as RunId;
const AT = "2026-10-14T10:00:00.000Z";
const AT_MESSAGE = "2026-10-14T10:06:00.000Z";

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
    expect(form).toContain("⏎ start");

    await ui.press("tab");
    await ui.waitFor("plan  [refine]  triage");
    await ui.press("tab");
    await ui.press("tab");
    await ui.waitFor("[plan]");
    await ui.press("Plan the export");
    await ui.press("\u001b[13;2u");
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
    await ui.press("enter");
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
    expect(done).toContain("/end end session");

    // A message of two lines: Option+Enter adds a line, Enter sends; Ctrl-S sends nothing.
    await ui.press("Why two?");
    await ui.press("\u001b\r");
    await ui.press("And the order?");
    await ui.press("ctrl-s");
    await Bun.sleep(50);
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
    await ui.press("enter");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.message"); i++) {
      await Bun.sleep(5);
    }
    const message = session.commands.find((c) => c.name === "planning.message");
    expect(message?.args).toEqual({ text: "Why two?\nAnd the order?" });
    // The message shows once the engine's view lists it, never as a line of the TUI's own.
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("you> ");
    stream?.options.onEvent(
      officeEvent(11, "planning.updated", {
        run: RUN,
        view: planningView({
          messages: [
            { run: RUN, text: "Why two?\nAnd the order?", outputOffset: 29, at: AT_MESSAGE },
          ],
        }),
      }),
    );
    const asked = await ui.waitFor("you> And the order?");
    expect(asked).toContain("you> Why two?");

    // Ending asks first; Ctrl-E does nothing, /end then Enter asks.
    await ui.press("ctrl-e");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("End the planning session?");
    await ui.press("/end");
    await ui.press("enter");
    await ui.waitFor("End the planning session? [y/N]");
    await ui.press("n");
    await ui.waitFor("the session stays open");
    await ui.press("/end");
    await ui.press("enter");
    await ui.press("y");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.end"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.some((c) => c.name === "planning.end")).toBe(true);
    stream?.options.onEvent(
      officeEvent(12, "planning.ended", {
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
          planning: planningView({
            turns: 2,
            continuedAt: "2026-10-14T09:30:00.000Z",
            sessions: [{ run: RUN, startedAt: "2026-10-14T09:30:00.000Z" }],
          }),
        },
      ],
    ]);
    const output = new Map([[`${RUN}:worker`, "Earlier answer one.\nEarlier answer two.\n"]]);
    const { ui, session } = await open({ columns: 120, rows: 30, snapshots, output });
    await ui.press("5");
    const frame = await ui.waitFor("Earlier answer two.");
    expect(frame).toContain("Planning · plan · waiting · 2 answers");
    expect(frame).toContain("goal: Plan the export feature");
    expect(frame).toContain("Earlier answer one.");

    // Continue it: a message goes to the open session, not to a new start.
    await ui.press("And a third?");
    await ui.press("enter");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.message"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.some((c) => c.name === "planning.start")).toBe(false);
    expect(session.commands.find((c) => c.name === "planning.message")?.args).toEqual({
      text: "And a third?",
    });
  });

  it("shows an open proposal as a card and confirms, declines and edits it with c, x and e (DIPO-487)", async () => {
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
    const frame = await ui.waitFor("Export as XML · S");
    expect(frame).toContain("◆ Export as CSV · M");
    expect(frame).toContain("As maintainer I want to export the stories as a CSV file");
    expect(frame).toContain("refused a proposal at");
    expect(frame).not.toContain("c confirm");
    expect(frame).not.toContain("▌ ◆");

    const sent = async (name: string) => {
      for (let i = 0; i < 100 && !session.commands.some((c) => c.name === name); i++) {
        await Bun.sleep(5);
      }
      return session.commands.find((c) => c.name === name);
    };

    // The modifier keys do nothing, with the input or a card in focus.
    for (const key of ["ctrl-y", "ctrl-d", "ctrl-r", "ctrl-g"]) await ui.press(key);
    await Bun.sleep(50);
    expect(
      session.commands.filter((c) => c.name.startsWith("planning.") && c.name !== "x"),
    ).toEqual([]);

    // Up on an empty input focuses the last card; the modifier keys still do nothing there.
    await ui.press("up");
    const focused = await ui.waitFor("▌ ◆ Export as XML · S");
    expect(focused).toContain("c confirm   e edit   x decline");
    for (const key of ["ctrl-y", "ctrl-d", "ctrl-r", "ctrl-g"]) await ui.press(key);
    await Bun.sleep(50);
    expect(session.commands.some((c) => c.name.startsWith("planning."))).toBe(false);
    await ui.press("x");
    expect((await sent("planning.decline"))?.args).toEqual({ proposal: 2 });
    await ui.waitFor("▌ ◆ Export as CSV · M");

    session.commandReply = (name) =>
      name === "planning.confirm"
        ? {
            ok: true,
            result: { run: RUN, proposal: 1, state: "filed", stories: ["DIPO-31"] },
            changed: true,
          }
        : undefined;
    await ui.press("c");
    expect((await sent("planning.confirm"))?.args).toEqual({ proposal: 1 });
    await ui.waitFor("proposal 1 confirmed: DIPO-31");

    // Esc and any other printable key return focus to the input; the key is typed there.
    session.commandReply = () => undefined;
    await ui.press("up");
    await ui.waitFor("▌ ◆");
    await ui.press("escape");
    await ui.waitFor("> _");
    expect(ui.frame()).not.toContain("▌ ◆");
    await ui.press("up");
    await ui.waitFor("▌ ◆");
    await ui.press("z");
    const typed = await ui.waitFor("> z_");
    expect(typed).not.toContain("▌ ◆");

    // Edit: the proposal goes into the input as a form, and Enter sends it as planning.edit.
    await ui.press("backspace");
    await ui.press("up");
    await ui.press("e");
    const editing = await ui.waitFor("editing proposal 2:");
    expect(editing).toContain("tier: S");
    expect(editing).toContain("⏎ save proposal 2");
    const why = "why: Why Export as XML: the maintainer asked for it.";
    for (let i = 0; i < why.length; i++) await ui.press("backspace");
    await ui.press("why: Shorter why.");
    await ui.press("enter");
    const edit = await sent("planning.edit");
    expect(edit?.args).toMatchObject({
      proposal: 2,
      edited: { kind: "story", title: "Export as XML", tier: "S", why: "Shorter why." },
    });
    await ui.waitFor("proposal 2 edited");
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
  });

  it("shows a confirmed proposal as one line and a declined one not at all, and focus moves only over cards (DIPO-487)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [
              filed(1, "Export as CSV", "DIPO-31"),
              { ...proposal(2, "Export as XML", "S"), state: "filing" },
              { ...proposal(3, "Export as JSON", "S"), state: "declined" },
              { ...proposal(4, "Export as YAML", "S"), state: "failed", detail: "lane closed it" },
              proposal(5, "Export as TOML", "M"),
            ],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui } = await open({ columns: 140, rows: 40, snapshots });
    await ui.press("5");
    const frame = await ui.waitFor("filed as DIPO-31");
    expect(frame.match(/filed as DIPO-31/g)).toHaveLength(1);
    expect(frame).toContain("filing… · Export as XML");
    expect(frame).not.toContain("◆ Export as CSV");
    expect(frame).not.toContain("◆ Export as XML");
    expect(frame).not.toContain("Export as JSON");
    expect(frame).toContain("✗ Export as YAML · S");
    expect(frame).toContain("failed: lane closed it");
    expect(frame).toContain("◆ Export as TOML · M");

    // Up focuses the last card, again the failed one, and no further: two cards, no others.
    await ui.press("up");
    await ui.waitFor("▌ ◆ Export as TOML");
    await ui.press("up");
    await ui.waitFor("▌ ✗ Export as YAML");
    await ui.press("up");
    await Bun.sleep(50);
    expect(ui.frame()).toContain("▌ ✗ Export as YAML");
    await ui.press("down");
    await ui.waitFor("▌ ◆ Export as TOML");
    await ui.press("down");
    await Bun.sleep(50);
    expect(ui.frame()).toContain("▌ ◆ Export as TOML");
  });

  it("opens and closes the stories fold-out on Tab, in one column with one input at the foot (DIPO-487)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [filed(1, "Export as CSV", "DIPO-31"), proposal(2, "Export as XML", "S")],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui } = await open({ columns: 112, rows: 30, snapshots });
    await ui.press("5");
    const closed = await ui.waitFor("◆ Export as XML");
    expect(closed).not.toContain("IN THIS PLAN");
    expect(closed).not.toContain("│");
    expect(closed.match(/^ > /gm)).toHaveLength(1);
    await ui.press("tab");
    const unfolded = await ui.waitFor("IN THIS PLAN");
    expect(unfolded).toContain("DIPO-31 Export as CSV · filed");
    expect(unfolded).toContain("1 filed, not Ready yet");
    expect(unfolded.match(/^ > /gm)).toHaveLength(1);
    await ui.press("tab");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("IN THIS PLAN");
  });

  it("shows a question block as a dialog, picks options and a free answer with keys, and sends the answers as one command (DIPO-455)", async () => {
    const block = {
      n: 1,
      at: "2026-10-14T10:04:00.000Z",
      questions: [
        {
          header: "Scope",
          question: "Should the export cover archived stories?",
          purpose: "It decides whether the CSV needs a status column.",
          options: [
            { label: "No", description: "Only active stories.", recommended: true },
            { label: "Yes", description: "Archived stories too." },
          ],
        },
        {
          header: "Format",
          question: "Which separator does the CSV use?",
          purpose: "Spreadsheets in some locales expect a semicolon.",
          options: [
            { label: "Comma", description: "The standard." },
            { label: "Semicolon", description: "For locales with a decimal comma." },
          ],
        },
      ],
    };
    const snapshots = new Map([
      [OFFICES.dipsaus, { ...golden(), planning: planningView({ questions: [block] }) }],
    ]);
    const { ui, session } = await open({ columns: 140, rows: 34, snapshots });
    await ui.press("5");
    const frame = await ui.waitFor("question 1 of 2");
    expect(frame).toContain("Should the export cover archived stories?");
    expect(frame).toContain("why I ask: It decides whether the CSV needs a status column.");
    expect(frame).toContain("▌ 1. No (recommended)");
    expect(frame).toContain("     Only active stories.");
    expect(frame).toContain("3. Something else: write your own answer");
    expect(frame).toContain("ctrl-s send (when all answered)");

    // Sending before every question has an answer sends nothing.
    await ui.press("ctrl-s");
    await ui.waitFor("answer every question first");
    expect(session.commands.some((c) => c.name === "planning.answer")).toBe(false);

    // Enter takes the recommended option; the next question takes a free answer.
    await ui.press("enter");
    await ui.waitFor("question 2 of 2");
    await ui.press("down");
    await ui.press("down");
    await ui.press("enter");
    const typing = await ui.waitFor("your answer: _");
    expect(typing).toContain("esc back to the options");
    await ui.press("A tab.");
    await ui.press("enter");
    const done = await ui.waitFor("Scope: No ✓");
    expect(done).toContain("Format: free: A tab. ✓");
    expect(done).toContain("ctrl-s send the answers");

    session.commandReply = (name) =>
      name === "planning.answer"
        ? { ok: true, result: { run: RUN, block: 1, delivered: "next-turn" }, changed: true }
        : undefined;
    await ui.press("ctrl-s");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.answer"); i++) {
      await Bun.sleep(5);
    }
    const sent = session.commands.filter((c) => c.name === "planning.answer");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toEqual({ block: 1, answers: [{ option: 0 }, { free: "A tab." }] });
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
  });

  it("opens the Ready step on /end, ticks and unticks, sets the ticked stories Ready and ends (DIPO-487)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [
              filed(1, "Export as CSV", "DIPO-31"),
              filed(2, "Export as XML", "DIPO-32"),
              filed(3, "Export as JSON", "DIPO-33"),
            ],
            ready: [{ story: "DIPO-33", state: "set", at: "2026-10-14T10:06:00.000Z" }],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui, session } = await open({ columns: 140, rows: 40, snapshots });
    await ui.press("5");
    await ui.waitFor("filed as DIPO-32");
    await ui.press("/end");
    await ui.press("enter");
    const step = await ui.waitFor("2 of 2 ticked");
    expect(step).toContain("▌ [x] DIPO-31 Export as CSV · M");
    expect(step).toContain("[x] DIPO-32 Export as XML · M");
    expect(step).not.toContain("DIPO-33 Export as JSON");
    expect(session.commands.some((c) => c.name.startsWith("planning."))).toBe(false);

    await ui.press("down");
    await ui.press(" ");
    const some = await ui.waitFor("1 of 2 ticked");
    expect(some).toContain("[ ] DIPO-32");
    await ui.press(" ");
    await ui.waitFor("2 of 2 ticked");
    await ui.press(" ");
    await ui.waitFor("1 of 2 ticked");

    session.commandReply = (name) =>
      name === "planning.ready"
        ? { ok: true, result: { run: RUN, queued: ["DIPO-31"], refused: [] }, changed: true }
        : undefined;
    await ui.press("Y");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.end"); i++) {
      await Bun.sleep(5);
    }
    const names = session.commands.map((c) => c.name).filter((n) => n.startsWith("planning."));
    expect(names).toEqual(["planning.ready", "planning.end"]);
    expect(session.commands.find((c) => c.name === "planning.ready")?.args).toEqual({
      stories: ["DIPO-31"],
    });
    await ui.waitFor("DIPO-31 set Ready; planning session ended");
  });

  it("shows each story the Ready step sent as set, queued or refused with the gate's messages (DIPO-487)", async () => {
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
    await ui.waitFor("filed as DIPO-32");
    await ui.press("/end");
    await ui.press("enter");
    await ui.waitFor("2 of 2 ticked");
    session.commandReply = (name) =>
      name === "planning.ready"
        ? {
            ok: true,
            result: {
              run: RUN,
              queued: ["DIPO-31"],
              refused: [{ story: "DIPO-32", messages: ["R08: no acceptance criteria"] }],
            },
            changed: true,
          }
        : name === "planning.end"
          ? { ok: false, error: { code: "planning.notOpen", message: "no open session" } }
          : undefined;
    await ui.press("y");
    const result = await ui.waitFor(
      "DIPO-32 refused and stays as it is: R08: no acceptance criteria",
    );
    expect(result).toContain("DIPO-31 queued");
  });

  it("ends with none Ready on n, keeps the session open on Esc, and asks to end when nothing is left (DIPO-487)", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          planning: planningView({
            proposals: [filed(1, "Export as CSV", "DIPO-31")],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const { ui, session } = await open({ columns: 140, rows: 40, snapshots });
    await ui.press("5");
    await ui.waitFor("filed as DIPO-31");
    await ui.press("/end");
    await ui.press("enter");
    await ui.waitFor("1 of 1 ticked");
    await ui.press("escape");
    await ui.waitFor("the session stays open");
    expect(ui.frame()).not.toContain("1 of 1 ticked");
    expect(session.commands.some((c) => c.name.startsWith("planning."))).toBe(false);
    await ui.press("/end");
    await ui.press("enter");
    await ui.waitFor("1 of 1 ticked");
    await ui.press("n");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.end"); i++) {
      await Bun.sleep(5);
    }
    expect(
      session.commands.filter((c) => c.name.startsWith("planning.")).map((c) => c.name),
    ).toEqual(["planning.end"]);
    await ui.waitFor("no story set Ready; planning session ended");
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
    expect(home).not.toContain("P plan");
    await ui.press("3");
    await ui.waitFor("r run");
  });
});

const sentMessage = async (session: Awaited<ReturnType<typeof open>>["session"]) => {
  for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.message"); i++) {
    await Bun.sleep(5);
  }
  return session.commands.find((c) => c.name === "planning.message");
};
const openSession = async () => {
  const snapshots = new Map([[OFFICES.dipsaus, { ...golden(), planning: planningView() }]]);
  return open({ columns: 120, rows: 30, snapshots });
};

describe("the keys of the planning view (DIPO-479)", () => {
  it("makes a new line on Shift+Enter, Option+Enter and a trailing backslash, and Enter sends", async () => {
    const { ui, session } = await openSession();
    await ui.press("5");
    await ui.waitFor("Planning · plan");
    await ui.press("one");
    await ui.press("\u001b\r");
    await ui.press("two");
    await ui.press("\u001b[13;2u");
    await ui.press("three\\");
    await ui.press("enter");
    await ui.press("four");
    await ui.waitFor("four");
    await ui.press("enter");
    expect((await sentMessage(session))?.args).toEqual({ text: "one\ntwo\nthree\nfour" });
  });

  it("asks to end on /end then Enter only, and Ctrl-E does nothing", async () => {
    const { ui, session } = await openSession();
    await ui.press("5");
    await ui.waitFor("Planning · plan");
    await ui.press("ctrl-e");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("End the planning session?");
    await ui.press("/end");
    await ui.press("enter");
    await ui.waitFor("End the planning session? [y/N]");
    await ui.press("y");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.end"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.some((c) => c.name === "planning.end")).toBe(true);
    expect(session.commands.some((c) => c.name === "planning.message")).toBe(false);
  });

  it("opens on 5 from every room, the card and the settings, and P opens nothing", async () => {
    const { ui } = await open();
    await ui.press("P");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("no open planning session");
    for (const room of ["1", "2", "3", "4"]) {
      await ui.press(room);
      await ui.press("5");
      await ui.waitFor("no open planning session");
      await ui.press("escape");
      await Bun.sleep(50);
      expect(ui.frame()).not.toContain("no open planning session");
    }
  });

  it("folds tool and thinking lines to one line each, opens a focused fold with Enter and shows no block text (DIPO-486)", async () => {
    const snapshots = new Map([[OFFICES.dipsaus, { ...golden(), planning: planningView() }]]);
    const target = `packages/engine/src/${"deep/".repeat(12)}export-command.ts`;
    const text = [
      "[thinking] 1.0s ~300 tokens",
      "[thinking] 2.0s ~500 tokens",
      `[tool] Read ${target}`,
      "I read the code. **Two** options, see `export.ts`.",
      "```dipo-questions",
      '{"questions": []}',
      "```",
      "",
    ].join("\n");
    const output = new Map([[`${RUN}:worker`, text]]);
    const { ui } = await open({ columns: 100, rows: 30, snapshots, output });
    await ui.press("5");
    const frame = await ui.waitFor("I read the code.");
    expect(frame).toContain("2 thoughts · 0.8k tokens");
    expect(frame).toContain("⏎ full");
    expect(frame).not.toContain("dipo-questions");
    expect(frame).not.toContain('"questions"');
    expect(frame).not.toContain("**");

    // Shift+Tab focuses the first fold, again the second (Tab opens the stories fold-out);
    // Enter opens it and Enter shuts it again.
    await ui.press("\u001b[Z");
    await ui.press("\u001b[Z");
    await ui.press("enter");
    const open1 = await ui.waitFor("port-command.ts");
    expect(open1).not.toContain("⏎ full");
    await ui.press("enter");
    expect(await ui.waitFor("⏎ full")).toContain("⏎ full");
  });
});

/** One open lane change waiting on backlog PR #656, whose CI is `ci` (DIPO-481). */
const laneOnPr = (ci: "running" | "failed"): LaneProgress => ({
  ops: [
    {
      op: 4,
      what: "a confirmed story filed",
      subject: "DIPO-489",
      state: "queued",
      since: "2026-10-14T10:00:00.000Z",
    },
  ],
  pr: { number: 656, url: "https://x/pull/656", ci, autoMerge: true, merged: false },
});
const filingView = (state: string, stories?: string[]) =>
  planningView({
    proposals: [
      {
        ...proposal(1, "Export as XML", "S"),
        state,
        ...(stories === undefined ? {} : { stories }),
      },
    ],
  } as Partial<PlanningView>);

describe("the filing line with the backlog PR (DIPO-481)", () => {
  it("names the backlog PR and its CI while filing, then says filed as DIPO-n", async () => {
    const waiting = await open({
      columns: 112,
      rows: 30,
      snapshots: new Map([
        [
          OFFICES.dipsaus,
          { ...golden(), planning: filingView("filing"), lane: laneOnPr("running") },
        ],
      ]),
    });
    await waiting.ui.press("5");
    await waiting.ui.waitFor("filing… waiting for backlog PR #656, CI running · Export as XML");
    // The PR's CI moves on with the engine's next read.
    const failed = await open({
      columns: 112,
      rows: 30,
      snapshots: new Map([
        [
          OFFICES.dipsaus,
          { ...golden(), planning: filingView("filing"), lane: laneOnPr("failed") },
        ],
      ]),
    });
    await failed.ui.press("5");
    await failed.ui.waitFor("filing… waiting for backlog PR #656, CI failed · Export as XML");
    // Filed: the lane is empty and the line says where the story went.
    const done = await open({
      columns: 112,
      rows: 30,
      snapshots: new Map([
        [OFFICES.dipsaus, { ...golden(), planning: filingView("filed", ["DIPO-489"]) }],
      ]),
    });
    await done.ui.press("5");
    const frame = await done.ui.waitFor("filed as DIPO-489 · Export as XML");
    expect(frame).not.toContain("backlog PR");
  });
});

describe("the Plan view of screens/07-plan.txt (DIPO-487)", () => {
  it("matches the mock at 112 columns", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...golden(),
          // The confirmed story waits for backlog PR #656 (DIPO-481).
          lane: laneOnPr("running"),
          planning: planningView({
            goal: "Split DIPO-116 into stories that can be Ready this week",
            turns: 2,
            messages: [
              {
                run: RUN,
                text: "Skip the plugin marketplace for now. What's the smallest story that lets a worker use one skill?",
                outputOffset: 0,
                at: AT_MESSAGE,
              },
            ],
            proposals: [
              filed(1, "Copy referenced skills into the box", "DIPO-488"),
              {
                ...proposal(2, "Refuse a story whose skill is missing", "S"),
                proposal: {
                  ...proposal(2, "Refuse a story whose skill is missing", "S").proposal,
                  storyLine:
                    "As maintainer I want the Ready gate to fail when a skill the story names is not in the repository so that a worker never starts without it.",
                },
              },
              { ...proposal(3, "Show the skill list in the story card", "S"), state: "filing" },
            ],
          } as Partial<PlanningView>),
        },
      ],
    ]);
    const output = new Map([
      [
        `${RUN}:worker`,
        "The smallest useful cut is a story that copies skills named in the story's\nreferences into the box.\nNo discovery and no plugins. Two stories:\n",
      ],
    ]);
    const { ui } = await open({ columns: 112, rows: 30, snapshots, output });
    await ui.press("5");
    await ui.waitFor("Refuse a story whose skill");
    await ui.press("up");
    await ui.waitFor("▌ ◆");
    // Every row under the header, cell for cell: the head, the conversation, the cards, the input and the footer.
    const ours = ui
      .frame()
      .split("\n")
      .map((row) => row.trimEnd());
    const mock = mockRows("07-plan.txt");
    expect(ours).toHaveLength(mock.length);
    expect(ours.slice(1)).toEqual(mock.slice(1));
  });
});

/** A planning session that continued once: two model sessions and the maintainer's messages. */
const continuedView = (extra: Partial<PlanningView> = {}) =>
  planningView({
    run: RUN2,
    session: RUN,
    continuedAt: "2026-10-14T11:30:00.000Z",
    sessions: [
      {
        run: RUN,
        startedAt: "2026-10-14T10:00:00.000Z",
        endedAt: "2026-10-14T11:29:00.000Z",
        ended: "context-full",
      },
      { run: RUN2, startedAt: "2026-10-14T11:30:00.000Z" },
    ],
    messages: [
      { run: RUN, text: "Why two stories?", outputOffset: 22, at: AT_MESSAGE },
      { run: RUN2, text: "Go on with the second.", outputOffset: 0, at: AT_MESSAGE },
    ],
    ...extra,
  });

const FIRST_OUTPUT = "First idea: split it.\nIt is two stories.\n";
const SECOND_OUTPUT = "Picking up: the second story.\n";

describe("one conversation per planning session (DIPO-490)", () => {
  it("keeps the first model session's conversation through a handover and adds the fresh one's", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        { ...golden(), planning: planningView({ sessions: [{ run: RUN, startedAt: AT }] }) },
      ],
    ]);
    const output = new Map([[`${RUN}:worker`, FIRST_OUTPUT]]);
    const { ui, session } = await open({ columns: 120, rows: 30, snapshots, output });
    await ui.press("5");
    await ui.waitFor("It is two stories.");
    const stream = session.active(STREAM);
    // The model session ended on a full context: the view stays, never the new-session form.
    stream?.options.onEvent(
      officeEvent(9, "planning.ended", {
        run: RUN,
        reason: "context-full",
        view: planningView({
          state: "ended",
          ended: "context-full",
          sessions: [{ run: RUN, startedAt: AT, ended: "context-full" }],
        }),
      }),
    );
    await Bun.sleep(50);
    const between = ui.frame();
    expect(between).toContain("It is two stories.");
    expect(between).not.toContain("no open planning session");

    session.output.set(`${RUN2}:worker`, SECOND_OUTPUT);
    stream?.options.onEvent(
      officeEvent(10, "planning.continued", {
        run: RUN2,
        previous: RUN,
        reason: "context-full",
        view: continuedView(),
      }),
    );
    const frame = await ui.waitFor("Picking up: the second story.");
    expect(frame).not.toContain("no open planning session");
    const order = [
      "First idea: split it.",
      "you> Why two stories?",
      "It is two stories.",
      "continued in a fresh model session at",
      "(context-full)",
      "you> Go on with the second.",
      "Picking up: the second story.",
    ].map((text) => frame.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(frame.match(/continued in a fresh model session/g)).toHaveLength(1);
  });

  it("shows the whole conversation to a TUI opened after the handover, and starts empty for a new session", async () => {
    const snapshots = new Map([[OFFICES.dipsaus, { ...golden(), planning: continuedView() }]]);
    const output = new Map([
      [`${RUN}:worker`, FIRST_OUTPUT],
      [`${RUN2}:worker`, SECOND_OUTPUT],
    ]);
    const { ui, session } = await open({ columns: 120, rows: 30, snapshots, output });
    await ui.press("5");
    const frame = await ui.waitFor("Picking up: the second story.");
    expect(frame).toContain("First idea: split it.");
    expect(frame).toContain("you> Why two stories?");
    expect(frame).toContain("you> Go on with the second.");
    expect(frame).toContain("continued in a fresh model session at");

    // Another planning session in the office starts an empty transcript.
    const OTHER = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P09" as RunId;
    const stream = session.active(STREAM);
    stream?.options.onEvent(
      officeEvent(9, "planning.ended", {
        run: RUN2,
        reason: "maintainer",
        view: continuedView({ state: "ended", ended: "maintainer" }),
      }),
    );
    await ui.waitFor("no open planning session");
    session.output.set(`${OTHER}:worker`, "A new session's first answer.\n");
    stream?.options.onEvent(
      officeEvent(10, "planning.started", {
        run: OTHER,
        view: planningView({ run: OTHER, session: OTHER, goal: "Another goal" }),
      }),
    );
    const fresh = await ui.waitFor("A new session's first answer.");
    expect(fresh).not.toContain("First idea: split it.");
    expect(fresh).not.toContain("you> ");
  });
});
