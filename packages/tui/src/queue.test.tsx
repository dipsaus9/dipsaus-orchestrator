// The queue and `u` (DIPO-54 test plan): sections in column order with counts, waiting and
// Refined rows, `R` on a row or on "next Ready story" through `work.run` (DIPO-458), started and
// skipped stories with reasons on one ticker line that clears on the next key, read-your-writes on
// the reply cursor, and errors with ^R retry.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, StoryView } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const KEY_30 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02";
const KEY_31 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C31";

async function openQueue(columns = 120) {
  const view = await mount({ columns, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  await view.ui.press("3");
  await view.ui.waitFor("next Ready story");
  return view;
}

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function storyEvent(seq: number, view: StoryView, from: string): Event {
  return {
    cursor: { stream: STREAM, seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "story.state",
    data: { story: view.story, key: view.key, from, to: view.lifecycle, view },
  } as Event;
}

function golden(key: string): StoryView {
  const view = goldenSnapshots.get(OFFICES.dipsaus)?.stories.find((story) => story.key === key);
  if (view === undefined) throw new Error(`no story ${key}`);
  return view;
}

describe("queue view", () => {
  it("lists sections in column order with counts, dependencies and the first gate message", async () => {
    const { ui } = await openQueue();
    const frame = lines(ui.frame());
    expect(frame[0]).toMatch(
      /^dipo \/ dipsaus-orchestrator {3}\+1 elsewhere · O +● daemon live {4}\d\d:\d\d$/,
    );
    expect(frame.slice(1)).toEqual([
      "1 Desk 2    2 Floor 3    3 Queue 2·1    4 Retro",
      "─".repeat(119),
      " ▌ next Ready story (the engine picks)",
      "   READY (2)   DIPO-30 S  Add park reasons to digest",
      "               DIPO-32 M  Desk sort order",
      "   WAITING (1) DIPO-31 M  Cost view                        needs DIPO-21",
      '   REFINED (1) DIPO-33 M  Office forget flow               R15 2 unknowns open or resolved without an answer: "Keep the…',
      "   DRAFT (1)   DRAFT-4    Retro ritual",
      "   RUNNING (3) DIPO-21 M  Stream worker events to the TUI",
      "               DIPO-24 S  Add verify retry",
      "               DIPO-19 L  Review the merge slot",
      '   DESK (1)    DIPO-29 L  Web client shell                 "after M2" (parked by you 3d)',
      "─".repeat(119),
      `↑↓ move   ⏎ story   R run   . show done   c copy id${" ".repeat(26)}: commands   ? keys   O offices   q q quit`,
    ]);
  });

  it("shows Done stories after .", async () => {
    const { ui } = await openQueue();
    expect(ui.frame()).not.toContain("DIPO-12");
    await ui.press(".");
    expect(await ui.waitFor("DONE (1)")).toContain("DONE (1)    DIPO-12 S  Office registry");
  });
});

describe("R runs stories", () => {
  it("shows a run's started and skipped stories once, on one ticker line, and clears it on the next key", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [
          { story: "DIPO-31", key: KEY_31, reason: "dependency" },
          { story: "DIPO-32", key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C32", reason: "starting" },
        ],
      },
      changed: false,
    });
    await ui.press("R");
    const done = await ui.waitFor("run next Ready story: done");
    const ticker = lines(done).filter((line) => line.includes("skipped"));
    expect(ticker).toHaveLength(1);
    expect(ticker[0]).toStartWith(
      "run next Ready story: done  ·  started DIPO-30  ·  skipped DIPO-31: a dependency is not Done (needs DIPO-21)  ·  skipp",
    );
    // The next key clears it: no skipped list stays under the view.
    await ui.press("j");
    await ui.waitFor("▌ READY (2)");
    expect(ui.frame()).not.toContain("skipped");
    expect(ui.frame()).not.toContain("run next Ready story");
  });

  it("shows the decision at once and the story in setup from it: the answer's cursor is the decision's own entry (DIPO-456)", async () => {
    const { ui, session } = await openQueue();
    // work.run answers at its decision; its one change moves the story out of Ready.
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [{ story: "DIPO-32", key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C32", reason: "starting" }],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("j");
    await ui.waitFor("▌ READY (2)");
    await ui.press("R");
    await ui.waitFor("waiting for the office stream");
    const starting = { ...golden(KEY_30), column: "running" } as StoryView;
    session.active(STREAM)?.options.onEvent(storyEvent(9, starting, "Ready"));
    const done = await ui.waitFor("run DIPO-30: done");
    expect(done).toContain("started DIPO-30");
    expect(done).toContain("skipped DIPO-32: already starting");
    expect(done).toContain("RUNNING (4)");
    expect(done).not.toContain("wait for its reply");
    // A second u is sent at once: nothing waits for the first start's setup.
    await ui.press("R");
    expect(ui.frame()).not.toContain("wait for its reply");
    expect(session.commands).toHaveLength(2);
  });

  it("sends work.run with the selected story; done once the stream passes the reply cursor", async () => {
    const { ui, session } = await openQueue();
    const reply = Promise.withResolvers<unknown>();
    session.runReply = () => reply.promise;
    await ui.press("j");
    await ui.waitFor("▌ READY (2)");
    await ui.press("R");
    await ui.waitFor("run DIPO-30: sending");
    expect(session.commands).toEqual([
      {
        name: "work.run",
        args: { stories: [KEY_30] },
        options: { office: OFFICES.dipsaus, requestId: "01J9ZK5Q8W3V4X6Y7Z8A9B0R01" },
      },
    ]);

    reply.resolve({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    const syncing = await ui.waitFor("waiting for the office stream");
    expect(syncing).toContain("started DIPO-30");

    // Seq 8 is not yet the reply cursor; seq 9 is.
    const office = session.active(STREAM);
    const running = { ...golden(KEY_30), lifecycle: "In Progress", column: "running" } as StoryView;
    office?.options.onEvent(storyEvent(8, running, "Ready"));
    await ui.waitFor("RUNNING (4)");
    expect(ui.frame()).toContain("waiting for the office stream");
    // The selection follows the story into its new section.
    expect(ui.frame()).toMatch(/^ ▌ +DIPO-30 S  Add park reasons/m);
    office?.options.onEvent(storyEvent(9, running, "Ready"));
    const done = await ui.waitFor("run DIPO-30: done");
    expect(done).toContain("started DIPO-30");
  });

  it("counts a re-read after the reply as caught up", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("R");
    await ui.waitFor("waiting for the office stream");
    // A history gap: the store reads the snapshot again, at seq 2, before seq 9 came.
    const base = goldenSnapshots.get(OFFICES.dipsaus)!;
    session.nextSnapshots.set(OFFICES.dipsaus, {
      ...base,
      cursor: { stream: STREAM, seq: 2 },
    } as typeof base);
    const stream = session.active(STREAM)!;
    stream.active = false;
    stream.options.onEnded?.({ code: "stream.resetRequired", message: "gap", retryable: false });
    await ui.waitFor("run next Ready story: done");
  });

  it("handles RR in one write: the first R sends, the second is refused, and the refusal clears when the run ends", async () => {
    const { ui, session } = await openQueue();
    const reply = Promise.withResolvers<unknown>();
    session.runReply = () => reply.promise;
    await ui.press("RR");
    await ui.waitFor("run next Ready story is being sent; wait for its reply");
    expect(session.commands).toHaveLength(1);
    reply.resolve({ ok: true, result: { started: [], skipped: [] }, changed: false });
    await ui.waitFor("run next Ready story: done");
    expect(ui.frame()).not.toContain("wait for its reply");
  });

  it("clears a refusal on the next key", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => new Promise(() => {});
    await ui.press("R");
    await ui.press("R");
    await ui.waitFor("wait for its reply");
    await ui.press("j");
    await ui.waitFor("▌ READY (2)");
    expect(ui.frame()).not.toContain("wait for its reply");
  });

  it("refuses a second R while the first run waits for the office stream, and keeps its lines", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("R");
    await ui.waitFor("waiting for the office stream");
    await ui.press("R");
    await ui.waitFor("waits for the office stream; wait until it is done");
    expect(session.commands).toHaveLength(1);
  });

  it("sends no story from the next Ready row and shows a dependency skip with its reason", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: { started: [], skipped: [{ story: "DIPO-31", key: KEY_31, reason: "dependency" }] },
      changed: false,
    });
    await ui.press("R");
    const frame = await ui.waitFor("run next Ready story: done");
    expect(frame).toContain("skipped DIPO-31: a dependency is not Done (needs DIPO-21)");
    expect(session.commands.map((command) => command.args)).toEqual([{}]);
  });

  it("sends the waiting story when it is selected", async () => {
    const { ui, session } = await openQueue();
    for (let i = 0; i < 3; i++) await ui.press("down");
    await ui.waitFor("▌ WAITING (1)");
    await ui.press("R");
    await ui.waitFor("run DIPO-31: done");
    expect(session.commands.map((command) => command.args)).toEqual([{ stories: [KEY_31] }]);
  });

  it("shows an error in the footer and retries a retryable one with Ctrl-R and the same request id", async () => {
    const { ui, session } = await openQueue();
    let calls = 0;
    session.runReply = () => {
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            error: { code: "engine.recovering", message: "the daemon recovers", retryable: true },
          }
        : { ok: true, result: { started: [], skipped: [] }, changed: false };
    };
    await ui.press("R");
    const failed = await ui.waitFor("engine.recovering: the daemon recovers");
    expect(failed).toContain("^R retry");
    await ui.press("ctrl-r");
    const retried = await ui.waitFor("no Ready story to start");
    expect(retried).not.toContain("^R retry");
    const ids = session.commands.map(
      (command) => (command.options as { requestId: string }).requestId,
    );
    expect(ids).toEqual(["01J9ZK5Q8W3V4X6Y7Z8A9B0R01", "01J9ZK5Q8W3V4X6Y7Z8A9B0R01"]);
  });

  it("offers no retry for an error that is not retryable", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: false,
      error: { code: "daemon.draining", message: "scheduling is off", retryable: false },
    });
    await ui.press("R");
    expect(await ui.waitFor("daemon.draining: scheduling is off")).not.toContain("^R");
    await ui.press("ctrl-r");
    expect(session.commands).toHaveLength(1);
  });

  it("sends nothing while offline", async () => {
    const { ui, session } = await openQueue();
    session.setState("reconnecting");
    await ui.waitFor("offline since");
    await ui.press("R");
    await ui.waitFor("offline: actions are disabled");
    expect(session.commands).toEqual([]);
  });
});
