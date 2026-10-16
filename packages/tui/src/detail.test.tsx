// The live agent detail (DIPO-55 test plan): the detail frame from the golden event log and the
// golden output log, live `work.output`, `w` and `v`, scrolling back through `work.outputRange`
// and End back to the tail, `X` then `y` sending `work.stop` with the story id, `X` then no, the
// follow-only tag, the `now` line, a run that ends, and Esc back to the view it came from. Frames
// are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, QuestionView, StoryView, WorkView } from "@dipsaus-orchestrator/contract";

import { MAX_QUESTIONS, questionLines } from "./detail";
import { goldenHello, goldenOutputEvents, goldenSnapshots, OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

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
    cursor: { stream: STREAM, epoch: "e2", seq },
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
      " now  looping @ · verify · verify: expected 3, received 4",
      " phase    verify                     │ output (worker) [w]orker* [v]erify",
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
      " signals  none                       │ [tool] Edit src/retry.ts (step 35)",
      "                                     │ Step 36: retries now stop at the cap in src/verify.ts.",
      "                                     │ [tool] Read test/retry.test.ts (step 37)",
      "                                     │ [tool] Edit src/log.ts (step 38)",
      "                                     │ Step 39: retries now stop at the cap in src/notice.ts.",
      "                                     │ [tool] Bash",
      "                                     │ [tool] Edit src/retry.ts (live)",
      "                                     │ following the tail",
      " [w]orker [v]erify  [k/j PgUp/PgDn] scroll  [End] follow tail  [X] stop  [Esc] back  [q] quit",
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
      expect(frame).toContain(" phase verify  health looping @  loop 2/3  verify failing");
      expect(frame).toContain(" criteria 2/3  [x][x][ ]");
      expect(frame).toContain(" signals: none");
      expect(frame).toContain(" output (worker)");
      for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("shows usage, the budget bar, signals with their start time and evidence markers", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ["evidence"] });
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
      signals: [{ signal: "quiet", since }],
      usage: { ...base.usage, run: { ...base.usage.run, estimatedCost: 0.84 } },
      evidence: { "usage.run.inputTokens": "claimed", "usage.run.estimatedCost": "estimated" },
    };
    session
      .active(STREAM)
      ?.options.onEvent(
        event(8, "work.observed", { work: base.work, signal: "quiet", since, view: updated }),
      );
    const frame = await ui.waitFor("quiet since");
    const local = new Date(Date.parse(since));
    const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    expect(frame).toContain(`signals  quiet since ${hhmm}`);
    expect(frame).toContain(" usage    in 210k* out 18k");
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
    expect(frame).not.toContain("Step 39:");
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

  it("X then y sends work.stop with the story id", async () => {
    const { ui, session } = await openDetail();
    await ui.press("X");
    const prompt = await ui.waitFor("Stop DIPO-24?");
    expect(prompt).toContain(
      " Stop DIPO-24? worker ends, branch kept, story parks as stopped. [y/N]",
    );
    expect(prompt).toContain("[y] stop the worker");
    expect(session.commands).toEqual([]);
    await ui.press("y");
    await ui.waitFor("stop DIPO-24: done");
    expect(session.commands).toEqual([
      {
        name: "work.stop",
        args: { story: "DIPO-24" },
        options: {
          office: OFFICES.dipsaus,
          requestId: "01J9ZK5Q8W3V4X6Y7Z8A9B0R01",
          confirmed: true,
        },
      },
    ]);
  });

  it("X then any other key keeps the run going", async () => {
    const { ui, session } = await openDetail();
    await ui.press("X");
    await ui.waitFor("Stop DIPO-24?");
    await ui.press("n");
    const frame = await ui.waitFor("DIPO-24 keeps running");
    expect(frame).not.toContain("Stop DIPO-24?");
    expect(session.commands).toEqual([]);
  });

  it("shows a stop the engine refused in the footer", async () => {
    const { ui, session } = await openDetail();
    session.stopReply = () => ({
      ok: false,
      error: { code: "story.notRunning", message: "DIPO-24 has no active run", retryable: false },
    });
    await ui.press("X");
    await ui.press("y");
    await ui.waitFor("stop DIPO-24: story.notRunning: DIPO-24 has no active run");
  });

  it("tags a follow-only run with [follow]", async () => {
    const { ui, session } = await openDetail();
    const base = golden24();
    const since = "2026-10-14T10:03:00.000Z";
    const view: WorkView = { ...base, signals: [{ signal: "follow-only", since }] };
    session
      .active(STREAM)
      ?.options.onEvent(
        event(8, "work.observed", { work: base.work, signal: "follow-only", since, view }),
      );
    const frame = await ui.waitFor("[follow]");
    expect(frame).toMatch(/run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24 {2}\[follow\]$/m);
  });

  it("keeps the last view and output when the run ends, and says where the story went", async () => {
    const { ui, session } = await openDetail();
    const parked = {
      ...story24(),
      lifecycle: "Parked",
      column: "desk",
      parked: {
        reason: "stopped",
        detail: "stopped",
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
    expect(frame).toContain(" run ended · DIPO-24 is Parked (stopped)");
    expect(frame).toContain("Step 39: retries now stop at the cap");
    await ui.press("X");
    await ui.waitFor("this run has ended; there is no worker to stop");
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
      " now  looping @ · verify · verify: expected 3, received 4",
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

  it("tags the worker output while privacy.storeCommandBodies is on", async () => {
    const { ui, session } = await openDetail();
    expect(ui.frame()).not.toContain("opt-in");
    const summary = goldenHello.offices.find((entry) => entry.office === OFFICES.dipsaus);
    session.active("software")?.options.onEvent({
      cursor: { stream: "software", epoch: "e1", seq: 90 },
      at: "2026-10-14T10:04:00.000Z",
      type: "office.summary",
      data: { ...summary, optIns: ["privacy.storeCommandBodies"] },
    } as Event);
    let frame = await ui.waitFor("opt-in storeCommandBodies");
    expect(frame).toContain("output (worker) [w]orker* [v]erify  opt-in storeCommandBodies");
    await ui.press("v");
    frame = await ui.waitFor("[v]erify*");
    expect(frame).not.toContain("opt-in storeCommandBodies");
  });
});
