// The queue and `u` (DIPO-54 test plan): sections in column order with counts, waiting and
// Refined rows, `u` on a row or on "next Ready story" through `work.run`, started and skipped
// stories with reasons, read-your-writes on the reply cursor, and errors with Ctrl-R retry.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, StoryView } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const KEY_30 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02";
const KEY_31 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C31";

async function openQueue(columns = 120) {
  const view = await mount({ columns, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("· live");
  await view.ui.press("2");
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
    cursor: { stream: STREAM, epoch: "e2", seq },
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
    expect(lines(ui.frame())).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " > next Ready story (the engine picks)",
      "   READY (2)   DIPO-30 S  Add park reasons to digest",
      "               DIPO-32 M  Desk sort order",
      "   WAITING (1) DIPO-31 M  Cost view                        needs DIPO-21",
      '   REFINED (1) DIPO-33 M  Office forget flow               R15 2 unknowns open or resolved without an answer: "Keep the…',
      "   DRAFT (1)   DRAFT-4    Retro ritual",
      "   RUNNING (3) DIPO-21 M  Stream worker events to the TUI",
      "               DIPO-24 S  Add verify retry",
      "               DIPO-19 L  Review the merge slot",
      '   HELD (1)    DIPO-29 L  Web client shell                 "after M2" (held 3d)',
      " r[u]n selected  [j/k] move  [.] show done  [1] overview  [o] offices  [q] quit",
    ]);
  });

  it("shows Done stories after .", async () => {
    const { ui } = await openQueue();
    expect(ui.frame()).not.toContain("DIPO-12");
    await ui.press(".");
    expect(await ui.waitFor("DONE (1)")).toContain("DONE (1)    DIPO-12 S  Office registry");
  });
});

describe("u runs stories", () => {
  it("sends work.run with the selected story; done once the stream passes the reply cursor", async () => {
    const { ui, session } = await openQueue();
    const reply = Promise.withResolvers<unknown>();
    session.runReply = () => reply.promise;
    await ui.press("j");
    await ui.waitFor("> READY (2)");
    await ui.press("u");
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
      cursor: { stream: STREAM, epoch: "e2", seq: 9 },
    });
    const syncing = await ui.waitFor("waiting for the office stream");
    expect(syncing).toContain("started DIPO-30 (run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30)");

    // Seq 8 is not yet the reply cursor; seq 9 is.
    const office = session.active(STREAM);
    const running = { ...golden(KEY_30), lifecycle: "In Progress", column: "running" } as StoryView;
    office?.options.onEvent(storyEvent(8, running, "Ready"));
    await ui.waitFor("RUNNING (4)");
    expect(ui.frame()).toContain("waiting for the office stream");
    // The selection follows the story into its new section.
    expect(ui.frame()).toMatch(/^ > +DIPO-30 S  Add park reasons/m);
    office?.options.onEvent(storyEvent(9, running, "Ready"));
    const done = await ui.waitFor("run DIPO-30: done");
    expect(done).toContain("started DIPO-30");
  });

  it("counts a re-read onto a newer epoch after the reply as caught up", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, epoch: "e2", seq: 9 },
    });
    await ui.press("u");
    await ui.waitFor("waiting for the office stream");
    // A history gap: the store reads the snapshot again, now on epoch e3, before seq 9 of e2 came.
    const base = goldenSnapshots.get(OFFICES.dipsaus)!;
    session.nextSnapshots.set(OFFICES.dipsaus, {
      ...base,
      cursor: { stream: STREAM, epoch: "e3", seq: 2 },
    } as typeof base);
    const stream = session.active(STREAM)!;
    stream.active = false;
    stream.options.onEnded?.({ code: "stream.resetRequired", message: "gap", retryable: false });
    await ui.waitFor("run next Ready story: done");
  });

  it("keeps waiting for a newer-epoch reply while the store is on the old epoch", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, epoch: "e3", seq: 1 },
    });
    await ui.press("u");
    await ui.waitFor("waiting for the office stream");
    const running = { ...golden(KEY_30), lifecycle: "In Progress", column: "running" } as StoryView;
    session.active(STREAM)?.options.onEvent(storyEvent(20, running, "Ready"));
    await ui.waitFor("RUNNING (4)");
    await Bun.sleep(150);
    expect(ui.frame()).toContain("waiting for the office stream");
    expect(ui.frame()).not.toContain("run next Ready story: done");
  });

  it("refuses a second u while the first run waits for the office stream, and keeps its lines", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, epoch: "e2", seq: 9 },
    });
    await ui.press("u");
    await ui.waitFor("waiting for the office stream");
    await ui.press("u");
    const frame = await ui.waitFor("waits for the office stream; wait until it is done");
    expect(frame).toContain("started DIPO-30");
    expect(session.commands).toHaveLength(1);
  });

  it("sends no story from the next Ready row and shows a dependency skip with its reason", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: { started: [], skipped: [{ story: "DIPO-31", key: KEY_31, reason: "dependency" }] },
      changed: false,
    });
    await ui.press("u");
    const frame = await ui.waitFor("run next Ready story: done");
    expect(frame).toContain("skipped DIPO-31: a dependency is not Done (needs DIPO-21)");
    expect(session.commands.map((command) => command.args)).toEqual([{}]);
  });

  it("sends the waiting story when it is selected", async () => {
    const { ui, session } = await openQueue();
    for (let i = 0; i < 3; i++) await ui.press("down");
    await ui.waitFor("> WAITING (1)");
    await ui.press("u");
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
    await ui.press("u");
    const failed = await ui.waitFor("engine.recovering: the daemon recovers");
    expect(failed).toContain("[Ctrl-R] retry");
    await ui.press("ctrl-r");
    const retried = await ui.waitFor("no Ready story to start");
    expect(retried).not.toContain("[Ctrl-R] retry");
    const ids = session.commands.map(
      (command) => (command.options as { requestId: string }).requestId,
    );
    expect(ids).toEqual(["01J9ZK5Q8W3V4X6Y7Z8A9B0R01", "01J9ZK5Q8W3V4X6Y7Z8A9B0R01"]);
  });

  it("offers no retry for an error that is not retryable", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: false,
      error: { code: "scheduling.off", message: "scheduling is off", retryable: false },
    });
    await ui.press("u");
    expect(await ui.waitFor("scheduling.off: scheduling is off")).not.toContain("Ctrl-R");
    await ui.press("ctrl-r");
    expect(session.commands).toHaveLength(1);
  });

  it("sends nothing while offline", async () => {
    const { ui, session } = await openQueue();
    session.setState("reconnecting");
    await ui.waitFor("OFFLINE since");
    await ui.press("u");
    await ui.waitFor("offline: actions are disabled");
    expect(session.commands).toEqual([]);
  });
});
