// The live agent detail (DIPO-55 test plan): the detail frame from the golden event log and the
// golden output log, live `work.output`, `w` and `v`, scrolling back through `work.outputRange`
// and End back to the tail, the follow-only tag, the `now` line, a run that ends, and Esc back to
// the view it came from. Across a daemon restart the header shows a stream error that does not
// retry, and the detail updates again once the daemon runs (DIPO-327). Frames are asserted with
// ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import {
  type Event,
  type QuestionView,
  SEQUENCE_SAMPLES,
  type StoryView,
  type WorkView,
} from "@dipsaus-orchestrator/contract";

import { MAX_QUESTIONS, promptLines, questionLines } from "./detail";
import {
  goldenHello,
  goldenOutputEvents,
  goldenSnapshots,
  OFFICES,
} from "../test/support/fake-session";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const RUN_24 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";
const KEY_24 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

/** The Frame's bands (DIPO-458): header, rooms and a rule above the body; a rule and the keys under it. */
const HEADER = expect.stringMatching(
  /^dipo \/ dipsaus-orchestrator .*● daemon live {4}\d\d:\d\d$/,
) as unknown as string;
const ROOMS = expect.stringMatching(/^1 Desk .*4 Retro$/) as unknown as string;
const RULE = expect.stringMatching(/^─+$/) as unknown as string;
const keys = (pattern: RegExp) => expect.stringMatching(pattern) as unknown as string;

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function golden24(): WorkView {
  const view = goldenSnapshots.get(OFFICES.dipsaus)?.work.find((w) => w.work.run === RUN_24);
  if (view === undefined) throw new Error("no DIPO-24 run in the golden log");
  return view;
}

function story24(): StoryView {
  const view = goldenSnapshots.get(OFFICES.dipsaus)?.stories.find((s) => s.key === KEY_24);
  if (view === undefined) throw new Error("no DIPO-24 story in the golden log");
  return view;
}

function event(seq: number, type: string, data: unknown): Event {
  return {
    cursor: { stream: STREAM, seq },
    at: "2026-10-14T10:05:00.000Z",
    type,
    data,
  } as Event;
}

/** Opens the detail of DIPO-24 from the overview: `j` selects it, Enter drills in. */
async function openDetail(options: { columns?: number; rows?: number; tail?: number } = {}) {
  const view = await mount({
    columns: options.columns ?? 120,
    rows: options.rows ?? 24,
    outputTailBytes: options.tail ?? 800,
  });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  await view.ui.press("j");
  await view.ui.waitFor("▌ ● DIPO-24");
  // Only the detail's own reads count; the overview read the tails of every run before (DIPO-81).
  view.session.reads.splice(0);
  await view.ui.press("enter");
  await view.ui.waitFor("following");
  return view;
}

/** The prompt is the fifth filter: all, worker, reviewer, verify, prompt. */
async function toPrompt(ui: { press(key: string): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) await ui.press("v");
}

function rangeReads(session: { reads: readonly { name: string; args: unknown }[] }) {
  return session.reads
    .filter((read) => read.name === "work.outputRange")
    .map((read) => read.args as { source: string; from: number; to?: number });
}

describe("live agent detail", () => {
  it("shows the detail frame from the golden logs, with live work.output at the tail", async () => {
    const { ui, session } = await openDetail();
    for (const output of goldenOutputEvents) session.storeOutput(output);
    await ui.waitFor("(live)");
    expect(lines(ui.frame())).toEqual([
      HEADER,
      ROOMS,
      RULE,
      "Add verify retry",
      "setup ━━ ● build ┄┄ review ┄┄ test ┄┄ merge                                                            loop 2 of 3 · 22m",
      RULE,
      "PHASE     build             │  all   worker   reviewer   verify   prompt                                     following ↓",
      "HEALTH    ● looping @       │         read   src/notice.ts (step 34)",
      "CRITERIA  2/3               │         edit   src/retry.ts (step 35)",
      "REVIEW    round 0           │         says   Step 36: retries now stop at the cap in src/verify.ts.",
      "                            │         read   test/retry.test.ts (step 37)",
      "USAGE                       │         edit   src/log.ts (step 38)",
      "in        1k                │         says   Step 39: retries now stop at the cap in src/notice.ts.",
      "out       100               │         bash",
      "cache w   0                 │         edit   src/retry.ts (live)",
      "cache r   0                 │  ── verify ───────────────────────────────────────────────────────────────────────────────",
      "turns     22                │                $ bun run verify",
      "                            │                oxfmt --check: ok",
      "BUDGET    78% of 300k       │                oxlint: ok",
      "━━━━━━━━━━━━━━━━━━━━━━━━━   │                tsc -b: ok",
      "                            │                FAIL test/retry.test.ts > caps at 3 retries",
      "MODEL     claude-sonnet     │                  expected 3, received 4",
      RULE,
      keys(
        /^p park {3}s steer {3}v stream {3}↑↓ scroll {3}G follow {3}z expand {3}c copy id +esc back {3}q q quit$/,
      ),
    ]);
    // The tail came from work.outputRange reads to the end; the live text came from the stream.
    expect(rangeReads(session).filter((read) => read.source === "worker")).toEqual([
      expect.objectContaining({ from: 0 }),
      expect.objectContaining({ from: 1705 }),
    ]);
  });

  it("stacks facts above the output below 100 columns and never writes a wider line", async () => {
    for (const columns of [99, 80, 60]) {
      const { ui } = await openDetail({ columns });
      const frame = ui.frame();
      expect(frame).toContain("setup ━━ ● build ┄┄ review ┄┄ test ┄┄ merge");
      expect(frame).toContain(" health looping @  loop 2/3  review round 0");
      expect(frame).toContain(" criteria 2/3  [x][x][ ]");
      expect(frame).not.toContain("signals");
      expect(frame).toContain("all   worker   reviewer   verify   prompt");
      for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("shows usage, the budget bar and health without a signals list", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("daemon live");
    await ui.press("enter");
    await ui.waitFor("following");
    const base = goldenSnapshots.get(OFFICES.dipsaus)!.work[0]!;
    const since = "2026-10-14T09:58:00.000Z";
    const updated: WorkView = {
      ...base,
      health: "quiet",
      usage: { ...base.usage, run: { ...base.usage.run, estimatedCost: 0.84 } },
      evidence: { "usage.run.inputTokens": "claimed", "usage.run.estimatedCost": "estimated" },
    };
    session
      .active(STREAM)
      ?.options.onEvent(
        event(8, "work.observed", { work: base.work, signal: "no-output", since, view: updated }),
      );
    const frame = await ui.waitFor("HEALTH    ● quiet .");
    // The watchdog fact is evidence on work.observed only; the detail shows the one health value.
    expect(frame).not.toContain("signals");
    expect(frame).not.toContain("no-output");
    // The TUI shows no evidence markers, so a claimed value shows plain.
    expect(frame).toContain("in        210k");
    expect(frame).toContain("out       18k");
    expect(frame).toContain("cache w   6k");
    expect(frame).toContain("cache r   1.1M");
    expect(frame).toContain("turns     31");
    expect(frame).toContain("BUDGET    52% of 300k");
    expect(frame).toContain("CRITERIA  4/7");
  });

  it("cycles the stream filter with v: all, worker, reviewer, verify, prompt, and tab does not", async () => {
    const { ui } = await openDetail();
    const tabs = () => lines(ui.frame()).find((line) => line.includes("reviewer   verify"))!;
    expect(tabs()).toContain("│  all   worker");
    await ui.press("v");
    // worker: the tool lines and the agent's words, no verify output
    const worker = await ui.waitFor("src/log.ts");
    expect(worker).not.toContain("$ bun run verify");
    await ui.press("v");
    await ui.waitFor("no reviewer output yet");
    await ui.press("v");
    const frame = await ui.waitFor("$ bun run verify");
    // Escape sequences of the stored output are not written to the terminal.
    expect(frame).toContain("FAIL test/retry.test.ts > caps at 3 retries");
    expect(frame).toContain("  expected 3, received 4");
    expect(frame).not.toContain("src/log.ts");
    await ui.press("v");
    await ui.waitFor("no prompt is stored");
    await ui.press("v");
    await ui.waitFor("src/log.ts");
    // Tab stays the next pane key: it does not switch the filter.
    await ui.press("tab");
    await Bun.sleep(50);
    expect(tabs()).toContain("│  all   worker");
  });

  it("reads earlier output with work.outputRange when scrolling up, and G follows the tail", async () => {
    // The pane keeps 1200 bytes of the 1705 stored: 27 of 40 lines; the worker filter shows them.
    const { ui, session } = await openDetail({ tail: 1200 });
    await ui.press("v");
    const before = rangeReads(session).length;
    await ui.press("k");
    let frame = await ui.waitFor("paused · G to follow");
    expect(frame).not.toContain("following");
    expect(frame).not.toContain("Step 39:");
    // No read yet: the pane still holds text above.
    expect(rangeReads(session)).toHaveLength(before);

    // A page up reaches the top of what is held: read the text before it.
    await ui.press("pageup");
    const deadline = performance.now() + 1_000;
    while (rangeReads(session).length === before && performance.now() < deadline) {
      await Bun.sleep(5);
    }
    const earlier = rangeReads(session).slice(before);
    expect(earlier).toHaveLength(1);
    // The read ends where the held text started and reaches back one step of the tail size.
    const read = earlier[0]!;
    expect(read).toMatchObject({ source: "worker", from: 0 });
    expect(read.to).toBeGreaterThan(0);

    await ui.press("pageup");
    await ui.press("pageup");
    frame = await ui.waitFor("start of output");
    expect(frame).toContain("Reading the story and the verify code first.");

    // New output while scrolled back does not move the rows on screen.
    session.storeOutput(goldenOutputEvents[0]!);
    await Bun.sleep(150);
    expect(lines(ui.frame()).slice(5, -3)).toEqual(lines(frame).slice(5, -3));

    await ui.press("G");
    frame = await ui.waitFor("following");
    expect(frame).toMatch(/│ +bash\n/);
  });

  it("z expands the stream to the whole screen and z or Esc brings the frame back", async () => {
    const { ui } = await openDetail();
    await ui.waitFor("dipo / dipsaus-orchestrator");
    await ui.waitFor("following");
    await ui.press("z");
    const deadline = performance.now() + 3_000;
    while (
      (ui.frame().includes("dipo / ") || !ui.frame().includes("following")) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    const expanded = ui.frame();
    expect(expanded).not.toContain("dipo / ");
    expect(expanded).not.toContain("q q quit");
    expect(expanded).toContain("following");
    expect(lines(expanded).length).toBeLessThanOrEqual(24);
    await ui.press("escape");
    await ui.waitFor("q q quit");
    // Esc closed only the expansion: the detail is still open.
    await ui.waitFor("following");
    await ui.press("z");
    await ui.press("z");
    await ui.waitFor("q q quit");
  });

  it("reads the gap when a work.output range was missed", async () => {
    const { ui, session } = await openDetail();
    const before = rangeReads(session).length;
    const [missed, next] = goldenOutputEvents;
    session.storeOutput(missed!, false);
    session.storeOutput(next!);
    const frame = await ui.waitFor("(live)");
    expect(frame).toMatch(/│ +bash\n/);
    expect(rangeReads(session).slice(before)[0]).toMatchObject({ source: "worker", from: 1705 });
  });

  it("shows one gap note when no read can fill a missed range, and goes on with the live output", async () => {
    const { ui, session } = await openDetail();
    const stored = session.output.get(`${RUN_24}:worker`)?.length ?? 0;
    const before = rangeReads(session).length;
    // 40 bytes past the stored output that nothing stored: the gap read finds nothing.
    const deliver = (seq: number, from: number, text: string) =>
      session.active(STREAM)?.options.onEvent(
        event(seq, "work.output", {
          work: golden24().work,
          source: "worker",
          from,
          to: from + text.length,
          text,
        }),
      );
    deliver(20, stored + 40, "late line\n");
    await ui.waitFor("[40 bytes of output not stored]");
    // Reads of the stored output past the gap: one per feed of this run (the detail and the
    // overview's now line), and none once the note is shown (DIPO-422).
    const gapReads = () =>
      rangeReads(session)
        .slice(before)
        .filter((read) => read.from === stored).length;
    const settled = gapReads();
    expect(settled).toBeLessThanOrEqual(2);
    await Bun.sleep(50);
    expect(gapReads()).toBe(settled);
    deliver(21, stored + 50, "after gap\n");
    const frame = await ui.waitFor("after gap");
    expect(frame.indexOf("[40 bytes of output not stored]")).toBeLessThan(
      frame.indexOf("late line"),
    );
  });

  it("P asks for a note and sends story.park with the story id", async () => {
    const { ui, session } = await openDetail();
    await ui.press("p");
    await ui.waitFor("park note for DIPO-24");
    expect(session.commands).toEqual([]);
    await ui.press("after the release");
    await ui.press("enter");
    await ui.waitFor("park DIPO-24: ");
    expect(session.commands.map((command) => [command.name, command.args])).toEqual([
      ["story.park", { story: "DIPO-24", note: "after the release" }],
    ]);
  });

  it("P then Esc sends nothing", async () => {
    const { ui, session } = await openDetail();
    await ui.press("p");
    await ui.waitFor("park note for DIPO-24");
    await ui.press("escape");
    await ui.waitFor("park DIPO-24: nothing sent");
    expect(session.commands).toEqual([]);
  });

  it("shows a park the engine refused in the footer", async () => {
    const { ui, session } = await openDetail();
    session.commandReply = (name) =>
      name === "story.park"
        ? {
            ok: false,
            error: {
              code: "story.notParkable",
              message: "DIPO-24 is Done",
              retryable: false,
            },
          }
        : undefined;
    await ui.press("p");
    await ui.press("later");
    await ui.press("enter");
    await ui.waitFor("park DIPO-24: story.notParkable: DIPO-24 is Done");
  });

  it("keeps the last view and output when the run ends, and says where the story went", async () => {
    const { ui, session } = await openDetail();
    const parked = {
      ...story24(),
      lifecycle: "Parked",
      column: "desk",
      parked: {
        reason: "by-maintainer",
        detail: "after the release",
        from: "In Progress",
        since: "2026-10-14T10:04:00Z",
      },
    } as StoryView;
    const { work: _work, ...withoutRun } = parked;
    session.active(STREAM)?.options.onEvent(
      event(8, "story.state", {
        story: "DIPO-24",
        key: KEY_24,
        from: "In Progress",
        to: "Parked",
        view: withoutRun,
      }),
    );
    const frame = await ui.waitFor("run ended");
    expect(frame).toContain(" run ended · DIPO-24 is Parked (by-maintainer)");
    expect(frame).toContain("Step 39: retries now stop at the cap");
    await ui.press("p");
    await ui.waitFor("this run has ended; park its story from the queue or the desk");
    expect(session.commands).toEqual([]);
  });

  it("Esc returns to the overview, or to the queue it came from", async () => {
    const { ui, session } = await openDetail();
    await ui.press("escape");
    let frame = await ui.waitFor("RUNNING");
    expect(frame).toContain("▌ ● DIPO-24");

    // DIPO-30 is Ready again after an earlier run: Enter opens that run, Esc comes back.
    session.runs.set("sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02", [
      {
        run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C02",
        agents: ["agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C02"],
        role: "developer",
        tier: "S",
        model: "claude-haiku",
        startedAt: "2026-10-14T07:00:00.000Z",
        endedAt: "2026-10-14T08:04:00.000Z",
        outcome: "completed",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          turns: 1,
          elapsedMs: 60_000,
        },
      } as never,
    ]);
    await ui.press("3");
    await ui.waitFor("▌ → DIPO-30");
    await ui.press("enter");
    await ui.waitFor("DIPO-30 Add park reasons to digest · developer");
    await ui.press("escape");
    frame = await ui.waitFor("READY");
    expect(frame).toContain("▌ → DIPO-30");
  });

  it("Enter on a story that never ran says it has not run yet (DIPO-81)", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    await view.ui.waitFor("READY");
    await view.ui.press("enter");
    await view.ui.waitFor("DIPO-30 Add park reasons to digest · Ready, not run yet");
  });
});

const Q1 = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q01";
const Q2 = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q02";
const Q3 = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q03";

function question(
  id: string,
  kind: string,
  text: string,
  askedAt: string,
  work = golden24().work,
): QuestionView {
  return { question: id, work, kind, text, askedAt } as QuestionView;
}

describe("open questions and the command opt-in in the detail (DIPO-83)", () => {
  it("shows a phase marker in the output pane as a rule with its time", async () => {
    const { ui, session } = await openDetail();
    for (const output of goldenOutputEvents) session.storeOutput(output);
    await ui.waitFor("(live)");
    const text = "[dipo] 2026-10-14T10:03:59.000Z phase verify\n";
    const at = "2026-10-14T10:03:59.000Z";
    const range = { from: 1749, to: 1749 + text.length };
    // The engine flags its marker (DIPO-95).
    session.storeOutput(
      event(10, "work.output", {
        work: golden24().work,
        source: "worker",
        ...range,
        text,
        markers: [{ ...range, kind: "phase", value: "verify", at }],
      }),
    );
    const local = new Date(Date.parse(at));
    const hm = [local.getHours(), local.getMinutes()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const frame = await ui.waitFor(`── verify · ${hm} ──`);
    expect(frame).not.toContain("[dipo]");
  });

  it("shows a worker line that imitates a marker as text, live and on reread (DIPO-95)", async () => {
    const forged = "[dipo] 2026-10-14T10:03:59.000Z phase done\n";
    const forgedEvent = (cursor: number, from: number) =>
      event(cursor, "work.output", {
        work: golden24().work,
        source: "worker",
        from,
        to: from + forged.length,
        text: forged,
      });
    const first = await openDetail();
    for (const output of goldenOutputEvents) first.session.storeOutput(output);
    await first.ui.waitFor("(live)");
    first.session.storeOutput(forgedEvent(10, 1749));
    const live = await first.ui.waitFor("phase done");
    expect(live).toContain("says   [dipo]");
    expect(live).not.toContain("phase: done");

    // Read back from the stored output on reopening: the engine's flagged marker is a rule, the
    // worker's line carries no flag and stays text.
    const marker = "[dipo] 2026-10-14T10:03:59.000Z phase verify\n";
    const from = 1749 + forged.length;
    const range = { from, to: from + marker.length };
    first.session.storeOutput(
      event(11, "work.output", {
        work: golden24().work,
        source: "worker",
        ...range,
        text: marker,
        markers: [{ ...range, kind: "phase", value: "verify", at: "2026-10-14T10:03:59.000Z" }],
      }),
      false,
    );
    await first.ui.press("escape");
    await first.ui.waitFor("▌ ● DIPO-24");
    await first.ui.press("enter");
    const reread = await first.ui.waitFor("── verify · ");
    expect(reread).toContain("[dipo] 2026-10-14T10:03:59.000Z phase done");
    expect(reread).not.toContain("phase: done");
    expect(reread).not.toContain("phase verify");
    expect(reread).not.toContain("phase: verify");
  });

  it("lists the story's open questions with kind, age, text and how to answer them", async () => {
    const { ui, session } = await openDetail();
    const height = lines(ui.frame()).length;
    const other = goldenSnapshots
      .get(OFFICES.dipsaus)
      ?.work.find((w) => w.work.story === "DIPO-21");
    const office = session.active(STREAM)?.options;
    // The test clock stands at 10:04:00.
    office?.onEvent(
      event(
        8,
        "question.asked",
        question(
          Q1,
          "question",
          "Which greeting\nshould the CLI print?",
          "2026-10-14T10:00:00.000Z",
        ),
      ),
    );
    office?.onEvent(
      event(
        9,
        "question.asked",
        question(Q2, "question", "May I drop the build folder?", "2026-10-14T10:03:30.000Z"),
      ),
    );
    if (other !== undefined) {
      office?.onEvent(
        event(
          10,
          "question.asked",
          question(Q3, "question", "Not this story", "2026-10-14T10:03:00.000Z", other.work),
        ),
      );
    }
    const frame = await ui.waitFor("May I drop the build folder?");
    expect(lines(frame).slice(6, 10)).toEqual([
      " ? question 4m ago · Which greeting should the CLI print?",
      `   answer: dipo answer ${Q1} <text>`,
      " ? question 30s ago · May I drop the build folder?",
      `   answer: dipo answer ${Q2} <text>`,
    ]);
    expect(frame).not.toContain("Not this story");
    // The questions take rows from the output pane; the frame keeps its height.
    expect(lines(frame).length).toBe(height);

    office?.onEvent(event(11, "question.closed", { question: Q1, work: golden24().work }));
    for (let i = 0; i < 50 && ui.frame().includes(Q1); i++) await Bun.sleep(20);
    const closed = ui.frame();
    expect(closed).not.toContain(Q1);
    expect(closed).toContain(`dipo answer ${Q2} <text>`);
  });

  it("shows at most three questions and counts the rest", () => {
    const work = golden24().work;
    const many = [0, 1, 2, 3, 4].map((n) =>
      question(
        `qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q1${n}`,
        "question",
        `q${n}`,
        `2026-10-14T10:0${n}:00.000Z`,
        work,
      ),
    );
    const out = questionLines(many.toReversed(), Date.parse("2026-10-14T10:05:00.000Z"), "·");
    expect(out.length).toBe(MAX_QUESTIONS * 2 + 1);
    expect(out[0]).toBe("? question 5m ago · q0");
    expect(out.at(-1)).toBe("  2 more open questions · dipo watch lists all");
    expect(questionLines([], 0, "·")).toEqual([]);
  });

  it("names the stored commands next to the stream filters while privacy.storeCommandBodies is on", async () => {
    const { ui, session } = await openDetail();
    expect(ui.frame()).not.toContain("stores");
    const summary = goldenHello.offices.find((entry) => entry.office === OFFICES.dipsaus);
    session.active("software")?.options.onEvent({
      cursor: { stream: "software", seq: 90 },
      at: "2026-10-14T10:04:00.000Z",
      type: "office.summary",
      data: { ...summary, optIns: ["privacy.storeCommandBodies"] },
    } as Event);
    let frame = await ui.waitFor("stores commands");
    expect(frame).toContain("stores commands · following");
    expect(frame).not.toContain("opt-in");
    // Commands are stored in the worker's output only: the verify tab does not say so.
    for (let i = 0; i < 3; i++) await ui.press("v");
    await Bun.sleep(50);
    frame = ui.frame();
    expect(frame).not.toContain("stores commands");
  });
});

describe("the stored prompt in the detail (DIPO-137)", () => {
  it("shows the system file and the first message in the prompt tab, and an unbound key does nothing", async () => {
    const { ui, session } = await openDetail();
    const agent = golden24().work.agent;
    session.prompts.set(`${RUN_24}:${agent}`, [
      { part: "system", text: "You are the developer.\nFollow the scope.\n" },
      { part: "message", text: "Story DIPO-24: add the verify retry." },
    ]);
    await toPrompt(ui);
    const frame = await ui.waitFor("first message");
    expect(frame).toContain("│  all   worker   reviewer   verify   prompt");
    expect(frame).toContain("  · system file");
    expect(frame).toContain("  You are the developer.");
    expect(frame).toContain("  Story DIPO-24: add the verify retry.");
    expect(session.reads).toContainEqual({
      name: "work.prompt",
      args: { office: OFFICES.dipsaus, run: RUN_24, agent },
    });
    // An unbound key neither switches the pane nor sends a command.
    await ui.press("x");
    expect(ui.frame()).toContain("  · system file");
    expect(session.commands.filter((command) => command.name !== "office.open")).toEqual([]);
    await ui.press("v");
    await ui.waitFor("src/log.ts");
  });

  it("says when no prompt is stored", async () => {
    const { ui } = await openDetail();
    await toPrompt(ui);
    const frame = await ui.waitFor("no prompt is stored");
    expect(frame).toContain("privacy.storePrompts is off");
  });

  it("reads the prompt once while live updates arrive, and keeps it on screen", async () => {
    const { ui, session } = await openDetail();
    const agent = golden24().work.agent;
    session.prompts.set(`${RUN_24}:${agent}`, [
      { part: "message", text: "Story DIPO-24: add the verify retry." },
    ]);
    await toPrompt(ui);
    await ui.waitFor("first message");
    const build: WorkView = { ...golden24(), phase: "build", health: "busy" };
    session.active(STREAM)?.options.onEvent(
      event(8, "work.phase", {
        work: build.work,
        phase: "build",
        progress: build.progress,
        view: build,
      }),
    );
    await ui.waitFor("build");
    expect(ui.frame()).toContain("  Story DIPO-24: add the verify retry.");
    expect(ui.frame()).not.toContain("reading prompt");
    expect(session.reads.filter((read) => read.name === "work.prompt")).toHaveLength(1);
  });
});

describe("worker thinking in the detail (DIPO-96)", () => {
  it("shows a finished thinking block as one folded line of the stream", async () => {
    const { ui, session } = await openDetail();
    const build: WorkView = {
      ...golden24(),
      phase: "build",
      health: "busy",
      lastOutputAt: "2026-10-14T10:03:58.000Z",
    };
    session.active(STREAM)?.options.onEvent(
      event(8, "work.phase", {
        work: build.work,
        phase: "build",
        progress: build.progress,
        view: build,
      }),
    );
    for (const output of goldenOutputEvents) session.storeOutput(output);
    await ui.waitFor("edit   src/retry.ts (live)");
    const last = goldenOutputEvents[goldenOutputEvents.length - 1];
    if (last === undefined) throw new Error("no golden work.output event");
    const data = last.data as { from: number; to: number; text: string };
    // What ingestion stores for one thinking block: counts only, no thinking text.
    const text = "[thinking] 0.9s ~265 tokens\n";
    session.storeOutput({
      ...last,
      cursor: { ...last.cursor, seq: last.cursor.seq + 1 },
      data: { ...data, from: data.to, to: data.to + text.length, text },
    } as Event);
    const frame = await ui.waitFor("thinking 0.9s · 0.3k tokens");
    expect(lines(frame).filter((line) => line.includes("thinking 0.9s"))).toHaveLength(1);
    expect(frame).not.toContain("[thinking]");
  });
});

describe("prompt pane text (DIPO-313)", () => {
  it("shows each sequence class as plain text", () => {
    for (const [name, sample] of Object.entries(SEQUENCE_SAMPLES)) {
      const shown = promptLines(
        [
          { part: "system", text: `Be${sample} careful\n` },
          { part: "message", text: `Do${sample} it\tnow\nnext` },
        ],
        "*",
      );
      expect([name, shown]).toEqual([
        name,
        ["* system file", "Be careful", "", "* first message", "Do it\tnow", "next"],
      ]);
    }
  });
});

/** The office stream as the client reports it ended: inactive, then `onEnded`. */
function endOffice(
  session: Awaited<ReturnType<typeof openDetail>>["session"],
  error: { code: string; message: string; retryable: boolean },
) {
  const subscription = session.active(STREAM);
  if (subscription === undefined) throw new Error("no office subscription");
  subscription.active = false;
  subscription.options.onEnded?.(error);
}

describe("the detail across a daemon restart (DIPO-327)", () => {
  const RECOVERING = {
    code: "engine.recovering",
    message: "The daemon is recovering its offices.",
    retryable: true,
  };

  it("shows a stream error that does not retry in the header until a reconnect", async () => {
    const { ui, session } = await openDetail();
    endOffice(session, { code: "internal", message: "the stream broke", retryable: false });
    const frame = await ui.waitFor("stream ended");
    expect(lines(frame)[0]).toMatch(
      /^dipo \/ dipsaus-orchestrator .*✗ stream ended: internal: the stream broke {4}\d\d:\d\d$/,
    );
    session.setState("reconnecting");
    await ui.waitFor("offline since");
    session.setState("open");
    await ui.waitFor("daemon live");
    expect(ui.frame()).not.toContain("stream ended");
  });

  it("follows the run again once the restarted daemon runs, and updates", async () => {
    const { ui, session, store } = await openDetail();
    const last = store.state.cursor;
    session.setState("reconnecting");
    await ui.waitFor("offline since");
    // The new daemon answers engine.hello while it recovers and refuses the re-sent subscription,
    // and every retry on the backoff, until it runs.
    session.hello = { ...goldenHello, daemon: "recovering" };
    session.refuseOffice = RECOVERING;
    session.setState("open");
    await Promise.resolve();
    endOffice(session, RECOVERING);
    await ui.waitFor("◌ daemon recovering");
    expect(ui.frame()).not.toContain("stream ended");

    // daemon.state on the software stream subscribes again at once, after the last cursor.
    session.refuseOffice = null;
    session.active("software")?.options.onEvent({
      cursor: { stream: "software", seq: 50 },
      at: "2026-10-14T10:05:00.000Z",
      type: "daemon.state",
      data: { from: "recovering", to: "running" },
    } as Event);
    await ui.waitFor("daemon live");
    expect(session.active(STREAM)?.after).toEqual(last);

    const build: WorkView = { ...golden24(), phase: "build", health: "busy" };
    session.active(STREAM)?.options.onEvent(
      event(8, "work.phase", {
        work: build.work,
        phase: "build",
        progress: build.progress,
        view: build,
      }),
    );
    const frame = await ui.waitFor("HEALTH    ● busy");
    expect(frame).toContain("setup ━━ ● build ┄┄ review ┄┄ test ┄┄ merge");
  });
});

describe("steering from the stream (DIPO-461)", () => {
  it("opens the Composer at the foot of the stream, keeps keys like q and v in the draft, and Esc cancels", async () => {
    const { ui, session } = await openDetail();
    await ui.press("s");
    await ui.waitFor("steer DIPO-24 · arrives at its next turn");
    await ui.press("quit v");
    const frame = await ui.waitFor("quit v");
    // The draft took the keys: the filter did not change, nothing quit and nothing was sent.
    expect(frame).toContain("│  all   worker");
    expect(frame).not.toContain("press q again");
    expect(frame).toContain("⏎ send");
    await ui.press("escape");
    await Bun.sleep(50);
    expect(ui.frame()).not.toContain("⏎ send");
    expect(session.commands.filter((command) => command.name === "work.steer")).toEqual([]);
  });

  it("shows the sent text as a you line with on-resume from the reply, and a refusal as not sent", async () => {
    const { ui, session } = await openDetail();
    let reply: unknown = {
      ok: true,
      result: { run: RUN_24, delivered: "on-resume" },
      changed: true,
    };
    session.commandReply = (name) => (name === "work.steer" ? reply : undefined);
    await ui.press("s");
    await ui.waitFor("⏎ send");
    await ui.press("Keep the old flag");
    await ui.press("enter");
    const frame = await ui.waitFor("Keep the old flag · delivered on resume");
    expect(frame).toMatch(/\d\d:\d\d {2}you {4}Keep the old flag/);
    expect(
      session.commands
        .filter((command) => command.name === "work.steer")
        .map(({ name, args }) => ({ name, args })),
    ).toEqual([{ name: "work.steer", args: { story: "DIPO-24", text: "Keep the old flag" } }]);

    reply = {
      ok: false,
      error: { code: "story.notSteerable", message: "the reviewer is working", retryable: false },
    };
    await ui.press("s");
    await ui.waitFor("⏎ send");
    await ui.press("Again");
    await ui.press("enter");
    await ui.waitFor("not sent: story.notSteerable: the reviewer is working");
    // The earlier line stays above the new one.
    expect(ui.frame()).toContain("delivered on resume");
  });

  it("shows a long command whole on Enter and cut again on the next Enter", async () => {
    const { ui, session } = await openDetail();
    const command = `bun test ${"packages/tui/src/some-long-test-name.test.ts ".repeat(4)}`.trim();
    const text = `[tool] Bash ${command}\n`;
    const last = goldenOutputEvents[goldenOutputEvents.length - 1]!;
    const data = last.data as { to: number };
    for (const output of goldenOutputEvents) session.storeOutput(output);
    session.storeOutput({
      ...last,
      cursor: { ...last.cursor, seq: last.cursor.seq + 1 },
      data: { ...(last.data as object), from: data.to, to: data.to + text.length, text },
    } as Event);
    const cut = await ui.waitFor("⏎ full");
    expect(cut).not.toContain(command);
    await ui.press("enter");
    let frame = await ui.waitFor("some-long-test-name.test.ts");
    expect(frame).not.toContain("⏎ full");
    expect(frame.split("some-long-test-name").length - 1).toBe(4);
    await ui.press("enter");
    frame = await ui.waitFor("⏎ full");
    expect(frame).toContain("bun test packages");
  });

  it("scrolling up pauses following and G follows again", async () => {
    const { ui } = await openDetail({ tail: 1200 });
    await ui.press("v");
    await ui.press("k");
    await ui.waitFor("paused · G to follow");
    await ui.press("G");
    await ui.waitFor("following");
  });
});
