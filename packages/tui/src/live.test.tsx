// An open TUI after a daemon restart (DIPO-322): the daemon refuses the office subscription the
// client sends again with `engine.recovering` while it recovers; the header says `catching up`,
// and once `daemon.state` reports `running` the store subscribes again after its last cursor, so
// the overview, the queue and the live agent detail take the next events without the maintainer
// leaving and entering the office. An open TUI drops a run from RUNNING on its `run.ended`; the
// engine's `ended` marker that follows in the same write carries no view (DIPO-421). Frames are
// asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import type { EngineError, Event, StoryView } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import type { FakeSession } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const LAST = { stream: STREAM, seq: 7 };
const KEY_24 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";
const KEY_30 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02";
const KEY_19 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C19";
const ENDED_AT = "2026-10-14T10:05:00.000Z";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

const RECOVERING: EngineError = {
  code: "engine.recovering",
  message: "The daemon is starting and recovering its offices; try again shortly.",
  retryable: true,
};

function officeEvent(seq: number, type: string, data: unknown): Event {
  return {
    cursor: { stream: STREAM, seq },
    at: "2026-10-14T10:05:00.000Z",
    type,
    data,
  } as Event;
}

function golden() {
  const snapshot = goldenSnapshots.get(OFFICES.dipsaus);
  if (snapshot === undefined) throw new Error("no dipsaus snapshot in the golden log");
  return snapshot;
}

function goldenStory(key: string): StoryView {
  const view = golden().stories.find((candidate) => candidate.key === key);
  if (view === undefined) throw new Error(`no story ${key}`);
  return view;
}

/**
 * As a daemon restart looks to the store: the re-sent office subscription is refused while the
 * daemon recovers, then the software stream reports `running`.
 */
async function restart(session: FakeSession, ui: { waitFor(text: string): Promise<string> }) {
  const office = session.active(STREAM);
  if (office === undefined) throw new Error("the office stream is not followed");
  office.active = false;
  office.options.onEnded?.(RECOVERING);
  await ui.waitFor("catching up");
  session.active("software")?.options.onEvent({
    cursor: { stream: "software", seq: 50 },
    at: "2026-10-14T10:05:00.000Z",
    type: "daemon.state",
    data: { from: "recovering", to: "running" },
  } as Event);
  await ui.waitFor("· live");
  // Subscribed again after the last cursor the store applied, not from the head.
  expect(session.active(STREAM)?.after).toEqual(LAST);
}

describe("an open TUI after a daemon restart", () => {
  it("keeps the overview and the queue live", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session, store } = view;
    await ui.waitFor("· live");
    await restart(session, ui);

    const before = golden().work[1]!;
    const moved = { ...before, phase: "review", health: "busy" };
    session.active(STREAM)?.options.onEvent(
      officeEvent(8, "work.phase", {
        work: moved.work,
        phase: "review",
        progress: moved.progress,
        view: moved,
      }),
    );
    await ui.waitFor("developer S  review  busy >");

    await ui.press("2");
    await ui.waitFor("next Ready story");
    const running = { ...goldenStory(KEY_30), lifecycle: "In Progress", column: "running" };
    session.active(STREAM)?.options.onEvent(
      officeEvent(9, "story.state", {
        story: running.story,
        key: running.key,
        from: "Ready",
        to: "In Progress",
        view: running,
      }),
    );
    await ui.waitFor("RUNNING (4)");
    expect(store.state.snapshots).toBe(1);
  });

  it("keeps the live agent detail live and shows where the story went", async () => {
    const view = await mount({ columns: 120, rows: 24, outputTailBytes: 800 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    await ui.press("j");
    await ui.waitFor("▌DIPO-24");
    await ui.press("enter");
    await ui.waitFor("following the tail");
    await restart(session, ui);

    const parked = {
      ...goldenStory(KEY_24),
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
      officeEvent(8, "story.state", {
        story: "DIPO-24",
        key: KEY_24,
        from: "In Progress",
        to: "Parked",
        view: withoutRun,
      }),
    );
    const frame = await ui.waitFor("run ended");
    expect(frame).toContain(" run ended · DIPO-24 is Parked (stopped)");
  });
});

/**
 * The write that ends a run done (`endRunMarked`): `run.ended`, then the `ended done` marker line
 * after the run's stored worker output, whose `work.output` carries no view since the run ended.
 * The marker is stored in `session` too, as the engine stores it.
 */
function endedDone(session: FakeSession, seq: number, key: string): Event[] {
  const view = golden().work.find((candidate) => candidate.work.key === key);
  if (view === undefined) throw new Error(`no run of ${key}`);
  const stored = `${view.work.run}:worker`;
  const before = session.output.get(stored) ?? "";
  const text = `[dipo] ${ENDED_AT} ended done\n`;
  const from = before.length;
  const to = from + text.length;
  session.output.set(stored, before + text);
  const flag = { from, to, kind: "ended", value: "done", at: ENDED_AT };
  session.markers.set(stored, [...(session.markers.get(stored) ?? []), flag]);
  return [
    officeEvent(seq, "run.ended", {
      run: view.work.run,
      kind: "story",
      ending: "done",
      endedAt: ENDED_AT,
      key,
      story: view.work.story,
    }),
    officeEvent(seq + 1, "work.output", {
      work: view.work,
      source: "worker",
      from,
      to,
      text,
      markers: [flag],
    }),
  ];
}

describe("an open TUI when a run ends (DIPO-421)", () => {
  it("drops the run from RUNNING in the overview before its story moves", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    expect(ui.frame()).toContain("3 running");
    expect(ui.frame()).toContain("DIPO-19");

    for (const event of endedDone(session, 8, KEY_19))
      session.active(STREAM)?.options.onEvent(event);
    const frame = await ui.waitFor("2 running");
    expect(frame).not.toContain("DIPO-19");
  });

  it("says the run ended in the live agent detail", async () => {
    const view = await mount({ columns: 120, rows: 24, outputTailBytes: 800 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    await ui.press("j");
    await ui.waitFor("▌DIPO-24");
    await ui.press("enter");
    await ui.waitFor("following the tail");

    for (const event of endedDone(session, 8, KEY_24))
      session.active(STREAM)?.options.onEvent(event);
    const frame = await ui.waitFor(" run ended · DIPO-24 is In Progress");
    // The engine marker the same write carried is drawn in the output pane.
    expect(frame).toContain("run ended: done");
  });
});
