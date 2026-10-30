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
  await view.ui.waitFor("· live");
  await view.ui.press("j");
  await view.ui.waitFor(">DIPO-24");
  // Only the detail's own reads count; the overview read the tails of every run before (DIPO-81).
  view.session.reads.splice(0);
  await view.ui.press("enter");
  await view.ui.waitFor("following the tail");
  return view;
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
      " dipsaus-orchestrator · daemon running · live",
      " DIPO-24 Add verify retry · developer · S · claude-sonnet · run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24",
      " now  looping @ · build · [tool] Edit src/retry.ts (live)",
      " phase    build                      │ output (worker) [w]orker* [v]erify [i] prompt",
      " health   looping @                  │ [tool] Read src/retry.ts (step 25)",
      " loop     2/3                        │ [tool] Edit src/verify.ts (step 26)",
      " verify   failing                    │ Step 27: retries now stop at the cap in test/retry.test.ts.",
      " review   round 0                    │ [tool] Read src/log.ts (step 28)",
      " criteria 2/3                        │ [tool] Edit src/notice.ts (step 29)",
      "          [x][x][ ]                  │ Step 30: retries now stop at the cap in src/retry.ts.",
      " usage    in 1k out 100              │ [tool] Read src/verify.ts (step 31)",
      "          cw 0 cr 0                  │ [tool] Edit test/retry.test.ts (step 32)",
      "          turns 22                   │ Step 33: retries now stop at the cap in src/log.ts.",
      " budget   [######--] 78% of 300k     │ [tool] Read src/notice.ts (step 34)",
      "                                     │ [tool] Edit src/retry.ts (step 35)",
      "                                     │ Step 36: retries now stop at the cap in src/verify.ts.",
      "                                     │ [tool] Read test/retry.test.ts (step 37)",
      "                                     │ [tool] Edit src/log.ts (step 38)",
      "                                     │ Step 39: retries now stop at the cap in src/notice.ts.",
      "                                     │ [tool] Bash",
      "                                     │ [tool] Edit src/retry.ts (live)",
      "                                     │ following the tail",
      " [P]ark  [s]teer  [w]orker [v]erify [i] prompt  [k/j PgUp/PgDn] scroll  [End] follow tail  [Esc] back  [q] quit",
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
      expect(frame).toContain(" phase build  health looping @  loop 2/3  verify failing");
      expect(frame).toContain(" criteria 2/3  [x][x][ ]");
      expect(frame).not.toContain("signals");
      expect(frame).toContain(" output (worker)");
      for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("shows usage, the budget bar and health without a signals list", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    await ui.press("enter");
    await ui.waitFor("following the tail");
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
    const frame = await ui.waitFor("health   quiet .");
    // The watchdog fact is evidence on work.observed only; the detail shows the one health value.
    expect(frame).not.toContain("signals");
    expect(frame).not.toContain("no-output");
    // Evidence markers are off (overview.tsx), so a claimed value shows plain.
    expect(frame).toContain(" usage    in 210k out 18k");
    expect(frame).toContain("          cw 6k cr 1.1M");
    expect(frame).toContain("          turns 31  ~$0.84");
    expect(frame).toContain(" budget   [####----] 52% of 300k");
    expect(frame).toContain(" criteria 4/7");
    expect(frame).toContain("[x][x][x][x][ ][ ][ ]");
    expect(frame).toContain(" now  quiet . · build · no output yet");
  });

  it("answers what the worker does now: the newest line and its age", async () => {
    const { ui, session } = await openDetail();
    const build: WorkView = {
      ...golden24(),
      phase: "build",
      health: "busy",
      lastOutputAt: "2026-10-14T10:03:48.000Z",
    };
    session.active(STREAM)?.options.onEvent(
      event(8, "work.phase", {
        work: build.work,
        phase: "build",
        progress: build.progress,
        view: build,
      }),
    );
    // The test clock stands at 10:04:00.
    await ui.waitFor(
      "now  busy > · build · Step 39: retries now stop at the cap in src/notice.ts. · 12s ago",
    );
    for (const output of goldenOutputEvents) session.storeOutput(output);
    await ui.waitFor("now  busy > · build · [tool] Edit src/retry.ts (live)");
  });

  it("switches to the verify output with v and back with w", async () => {
    const { ui } = await openDetail();
    await ui.press("v");
    const frame = await ui.waitFor("output (verify)");
    expect(frame).toContain("[w]orker [v]erify*");
    expect(frame).toContain("│ $ bun run verify");
    // Escape sequences of the stored output are not written to the terminal.
    expect(frame).toContain("│ FAIL test/retry.test.ts > caps at 3 retries");
    expect(frame).toContain("│   expected 3, received 4");
    await ui.press("w");
    await ui.waitFor("output (worker)");
  });

  it("reads earlier output with work.outputRange when scrolling up, and End follows the tail", async () => {
    // The pane keeps 1200 bytes of the 1705 stored: 27 of 40 lines, 17 rows on screen.
    const { ui, session } = await openDetail({ tail: 1200 });
    const before = rangeReads(session).length;
    await ui.press("k");
    let frame = await ui.waitFor("[End] follow tail");
    expect(frame).toContain("1 rows below");
    expect(frame).not.toContain("│ Step 39:");
    // No read yet: the pane still holds text above.
    expect(rangeReads(session)).toHaveLength(before);

    // A page up reaches the top of what is held: read the text before it.
    await ui.press("pageup");
    await ui.waitFor("10 rows below");
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
    expect(frame).toContain("│ Reading the story and the verify code first.");

    // New output while scrolled back does not move the rows on screen.
    session.storeOutput(goldenOutputEvents[0]!);
    await Bun.sleep(150);
    expect(lines(ui.frame()).slice(3, -2)).toEqual(lines(frame).slice(3, -2));

    await ui.press("end");
    frame = await ui.waitFor("following the tail");
    expect(frame).toContain("│ [tool] Bash");
  });

  it("reads the gap when a work.output range was missed", async () => {
    const { ui, session } = await openDetail();
    const before = rangeReads(session).length;
    const [missed, next] = goldenOutputEvents;
    session.storeOutput(missed!, false);
    session.storeOutput(next!);
    const frame = await ui.waitFor("(live)");
    expect(frame).toContain("│ [tool] Bash\n");
    expect(rangeReads(session).slice(before)[0]).toMatchObject({ source: "worker", from: 1705 });
  });

  it("P asks for a note and sends story.park with the story id", async () => {
    const { ui, session } = await openDetail();
    await ui.press("P");
    await ui.waitFor("park note for DIPO-24: _");
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
    await ui.press("P");
    await ui.waitFor("park note for DIPO-24: _");
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
    await ui.press("P");
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
    await ui.press("P");
    await ui.waitFor("this run has ended; park its story from the queue or the desk");
    expect(session.commands).toEqual([]);
  });

  it("Esc returns to the overview, or to the queue it came from", async () => {
    const { ui } = await openDetail();
    await ui.press("escape");
    let frame = await ui.waitFor("RUNNING (3)");
    expect(frame).toContain(">DIPO-24");

    await ui.press("2");
    await ui.waitFor("next Ready story");
    // RUNNING: DIPO-21 is the row after six others in the queue.
    for (let i = 0; i < 6; i++) await ui.press("j");
    await ui.waitFor("> RUNNING (3) DIPO-21");
    await ui.press("enter");
    await ui.waitFor("DIPO-21 Stream worker events to the TUI · developer");
    await ui.press("escape");
    frame = await ui.waitFor("next Ready story");
    expect(frame).toContain("> RUNNING (3) DIPO-21");
  });

  it("Enter on a story that never ran says it has not run yet (DIPO-81)", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    await view.ui.waitFor("· live");
    await view.ui.press("2");
    await view.ui.waitFor("next Ready story");
    await view.ui.press("j");
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
    const hms = [local.getHours(), local.getMinutes(), local.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const frame = await ui.waitFor(`── ${hms} phase: verify ──`);
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
    expect(live).toContain("[dipo]");
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
    await first.ui.waitFor(">DIPO-24");
    await first.ui.press("enter");
    const reread = await first.ui.waitFor("phase: verify ──");
    expect(reread).toContain("[dipo] 2026-10-14T10:03:59.000Z phase done");
    expect(reread).not.toContain("phase: done");
    expect(reread).not.toContain("phase verify");
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
        question(Q2, "permission", "Bash: rm -rf build", "2026-10-14T10:03:30.000Z"),
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
    const frame = await ui.waitFor("allow|deny");
    expect(lines(frame).slice(2, 7)).toEqual([
      " now  looping @ · build · Step 39: retries now stop at the cap in src/notice.ts.",
      " ? question 4m ago · Which greeting should the CLI print?",
      `   answer: dipo answer ${Q1} <text>`,
      " ? permission 30s ago · Bash: rm -rf build",
      `   answer: dipo answer ${Q2} allow|deny`,
    ]);
    expect(frame).not.toContain("Not this story");
    // The questions take rows from the output pane; the frame keeps its height.
    expect(lines(frame).length).toBe(height);

    office?.onEvent(event(11, "question.closed", { question: Q1, work: golden24().work }));
    for (let i = 0; i < 50 && ui.frame().includes(Q1); i++) await Bun.sleep(20);
    const closed = ui.frame();
    expect(closed).not.toContain(Q1);
    expect(closed).toContain(`dipo answer ${Q2} allow|deny`);
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

  it("names the stored commands in the worker output title while privacy.storeCommandBodies is on", async () => {
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
    expect(frame).toContain("output (worker) [w]orker* [v]erify [i] prompt  stores commands");
    expect(frame).not.toContain("opt-in");
    await ui.press("v");
    frame = await ui.waitFor("[v]erify*");
    expect(frame).not.toContain("stores commands");
  });
});

describe("the stored prompt in the detail (DIPO-137)", () => {
  it("shows the system file and the first message on i, and Esc leaves p unbound", async () => {
    const { ui, session } = await openDetail();
    const agent = golden24().work.agent;
    session.prompts.set(`${RUN_24}:${agent}`, [
      { part: "system", text: "You are the developer.\nFollow the scope.\n" },
      { part: "message", text: "Story DIPO-24: add the verify retry." },
    ]);
    await ui.press("i");
    const frame = await ui.waitFor("first message");
    expect(frame).toContain("prompt (stored) [w]orker [v]erify [i] prompt*");
    expect(frame).toContain("│ · system file");
    expect(frame).toContain("│ You are the developer.");
    expect(frame).toContain("│ Story DIPO-24: add the verify retry.");
    expect(session.reads).toContainEqual({
      name: "work.prompt",
      args: { office: OFFICES.dipsaus, run: RUN_24, agent },
    });
    // p stays pause: it neither switches the pane nor sends a command.
    await ui.press("p");
    expect(ui.frame()).toContain("│ · system file");
    expect(session.commands.filter((command) => command.name !== "office.open")).toEqual([]);
    await ui.press("w");
    await ui.waitFor("output (worker)");
  });

  it("says when no prompt is stored", async () => {
    const { ui } = await openDetail();
    await ui.press("i");
    const frame = await ui.waitFor("no prompt is stored");
    expect(frame).toContain("privacy.storePrompts is off");
  });

  it("reads the prompt once while live updates arrive, and keeps it on screen", async () => {
    const { ui, session } = await openDetail();
    const agent = golden24().work.agent;
    session.prompts.set(`${RUN_24}:${agent}`, [
      { part: "message", text: "Story DIPO-24: add the verify retry." },
    ]);
    await ui.press("i");
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
    expect(ui.frame()).toContain("│ Story DIPO-24: add the verify retry.");
    expect(ui.frame()).not.toContain("reading prompt");
    expect(session.reads.filter((read) => read.name === "work.prompt")).toHaveLength(1);
  });
});

describe("worker thinking in the detail (DIPO-96)", () => {
  it("shows a finished thinking block on the now line and in the output pane", async () => {
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
    await ui.waitFor("[tool] Edit src/retry.ts (live)");
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
    const frame = await ui.waitFor("now  busy > · build · [thinking] 0.9s ~265 tokens · 2s ago");
    expect(
      lines(frame).filter((line) => line.includes("[thinking] 0.9s ~265 tokens")),
    ).toHaveLength(2);
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
    expect(lines(frame)[0]).toBe(
      " dipsaus-orchestrator · daemon running · stream ended: internal: the stream broke",
    );
    session.setState("reconnecting");
    await ui.waitFor("OFFLINE since");
    session.setState("open");
    await ui.waitFor("daemon running · live");
    expect(ui.frame()).not.toContain("stream ended");
  });

  it("follows the run again once the restarted daemon runs, and updates", async () => {
    const { ui, session, store } = await openDetail();
    const last = store.state.cursor;
    session.setState("reconnecting");
    await ui.waitFor("OFFLINE since");
    // The new daemon answers engine.hello while it recovers and refuses the re-sent subscription,
    // and every retry on the backoff, until it runs.
    session.hello = { ...goldenHello, daemon: "recovering" };
    session.refuseOffice = RECOVERING;
    session.setState("open");
    await Promise.resolve();
    endOffice(session, RECOVERING);
    await ui.waitFor("daemon recovering · catching up");
    expect(ui.frame()).not.toContain("stream ended");

    // daemon.state on the software stream subscribes again at once, after the last cursor.
    session.refuseOffice = null;
    session.active("software")?.options.onEvent({
      cursor: { stream: "software", seq: 50 },
      at: "2026-10-14T10:05:00.000Z",
      type: "daemon.state",
      data: { from: "recovering", to: "running" },
    } as Event);
    await ui.waitFor("daemon running · live");
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
    const frame = await ui.waitFor("now  busy > · build");
    expect(frame).toContain(" phase    build");
  });
});
