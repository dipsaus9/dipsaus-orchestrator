// Render tests of the TUI (DIPO-53 test plan): the switcher from the golden event log, switching
// with `office.switch`, the offline and daemon banners, quitting, narrow terminals, `--ascii` and
// colour, and `n` through `office.open`. Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { RELOADED_NOTICE } from "@dipsaus-orchestrator/client";
import type { Event } from "@dipsaus-orchestrator/contract";

import { OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];

async function open(options: Parameters<typeof mount>[0] = {}) {
  const view = await mount(options);
  mounted.push(view.ui);
  return view;
}

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function daemonState(to: string, seq: number): Event {
  return {
    cursor: { stream: "software", epoch: "e1", seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "daemon.state",
    data: { from: "running", to },
  } as Event;
}

describe("office switcher", () => {
  it("lists the three offices of the golden event log; arrows and Enter select one", async () => {
    const { ui, session, store } = await open();
    await ui.waitFor("dipsaus-orchestrator · daemon running");
    await ui.press("o");
    const frame = await ui.waitFor("slaydoku");
    expect(frame).toContain("Offices");
    expect(frame).toContain(
      [
        "   OFFICE                RUNNING  NEEDS YOU  READY  HELD  TODAY",
        " > dipsaus-orchestrator  3        2          2      1            (open)",
        "   couchcade             0        0          1      0",
        "   slaydoku              1        1          0      0     84% !",
      ].join("\n"),
    );
    expect(frame).toContain("[Enter] open  [n] open new repo path");

    await ui.press("down");
    await ui.press("down");
    await ui.waitFor("> slaydoku");
    await ui.press("up");
    await ui.waitFor("> couchcade");
    await ui.press("down");
    await ui.press("enter");
    const opened = await ui.waitFor("slaydoku · daemon running");
    expect(opened).toContain("SLAY-9");
    expect(opened).toContain("looping @");

    // Enter sent the read office.switch; the store left the old stream and follows the new one
    // after the cursor the read returned (0005 section 8).
    // The overview reads the new office's output tails after it (DIPO-81).
    expect(session.reads.filter((read) => read.name !== "work.outputRange").at(-1)).toEqual({
      name: "office.switch",
      args: { office: OFFICES.slaydoku },
    });
    expect(session.active(`office:${OFFICES.dipsaus}`)).toBeUndefined();
    expect(session.active(`office:${OFFICES.slaydoku}`)?.after).toEqual({
      stream: `office:${OFFICES.slaydoku}`,
      epoch: "e4",
      seq: 12,
    });
    expect(store.state.office).toBe(OFFICES.slaydoku);
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["SLAY-9"]);
  });

  it("lines the columns up at 120 and spells out a day usage alert (DIPO-81)", async () => {
    const { ui } = await open({ columns: 120, rows: 30 });
    await ui.waitFor("· live");
    await ui.press("o");
    const frame = await ui.waitFor("slaydoku");
    expect(frame).toContain(
      [
        "   OFFICE                RUNNING  NEEDS YOU  READY  HELD  TODAY",
        " > dipsaus-orchestrator  3        2          2      1                           (open)",
        "   couchcade             0        0          1      0",
        "   slaydoku              1        1          0      0     84%  ALERT day usage",
      ].join("\n"),
    );
  });

  it("shows READY as ? for a summary without it, and [q] quit at every width", async () => {
    for (const columns of [120, 80, 70, 60]) {
      const { ui, session } = await open({ columns, rows: 30 });
      await ui.waitFor("· live");
      session.active("software")?.options.onEvent({
        cursor: { stream: "software", epoch: "e1", seq: 60 },
        at: "2026-10-14T10:05:00.000Z",
        type: "office.summary",
        data: {
          office: OFFICES.couchcade,
          name: "couchcade",
          path: "/work/couchcade",
          running: 0,
          parked: 0,
          onHold: 0,
          waitingOnMaintainer: 0,
        },
      } as Event);
      await ui.press("o");
      const frame = await ui.waitFor("   couchcade             0        0          ?      0");
      expect(frame.split("\n").at(-1)).toContain("[q] quit");
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("starts in the switcher when no office is open, and Esc does not leave it", async () => {
    const { ui } = await open({ office: null });
    await ui.waitFor("slaydoku");
    await ui.press("escape");
    expect(ui.frame()).toContain("Offices");
  });

  it("opens a new repository path with n through office.open, then switches to it", async () => {
    const { ui, session } = await open();
    session.opened.set("/work/slaydoku", OFFICES.slaydoku);
    await ui.press("o");
    await ui.waitFor("Offices");
    await ui.press("n");
    await ui.waitFor("open repository path: _");
    await ui.press("/work/slaydokx");
    await ui.press("backspace");
    await ui.press("u");
    await ui.waitFor("open repository path: /work/slaydoku_");
    await ui.press("enter");
    await ui.waitFor("slaydoku · daemon running");
    expect(session.commands).toEqual([{ name: "office.open", args: { path: "/work/slaydoku" } }]);
  });

  it("shows why office.open failed and returns to the list", async () => {
    const { ui } = await open();
    await ui.press("o");
    await ui.press("n");
    await ui.press("/nowhere");
    await ui.press("enter");
    const frame = await ui.waitFor("office.notFound: not a repository");
    expect(frame).toContain("Offices");
  });
});

describe("connection and daemon states", () => {
  it("disconnected: shows the offline banner and disables action keys", async () => {
    const { ui, session } = await open();
    await ui.waitFor("· live");
    session.setState("reconnecting");
    const frame = await ui.waitFor("OFFLINE since");
    // The test clock is at 10:04 UTC; the banner shows local time.
    // The header carries it: the daemon state is unknown while disconnected.
    expect(frame).toMatch(/^ dipsaus-orchestrator · OFFLINE since \d\d:\d\d – view frozen$/m);
    expect(frame).not.toContain("daemon running");
    expect(frame).toContain("(offline: actions disabled)");
    // Values keep their last state.
    expect(frame).toContain("DIPO-21");

    await ui.press("o");
    await ui.press("down");
    await ui.press("enter");
    await ui.waitFor("offline: actions are disabled");
    expect(session.reads.filter((read) => read.name === "office.switch")).toEqual([]);
    await ui.press("n");
    expect(ui.frame()).not.toContain("open repository path");
  });

  it("shows the recovering, draining and safe banners", async () => {
    const { ui, session } = await open();
    await ui.waitFor("· live");
    const software = session.active("software");
    software?.options.onEvent(daemonState("recovering", 50));
    await ui.waitFor("Daemon recovering – office data after reconcile");
    software?.options.onEvent(daemonState("draining", 51));
    await ui.waitFor("Daemon stopping – will reconnect");
    software?.options.onEvent(daemonState("safe", 52));
    const frame = await ui.waitFor("Scheduling off after repeated crashes – [S] resume scheduling");
    expect(frame).toContain("daemon safe");

    await ui.press("S");
    await ui.waitFor("Resume scheduling? [y/N]");
    await ui.press("y");
    await ui.waitFor("scheduling resumed");
    expect(session.commands).toEqual([{ name: "daemon.resumeScheduling", args: {} }]);
  });

  it("after a draining daemon goes away, shows offline instead of the stale draining state", async () => {
    const { ui, session } = await open();
    await ui.waitFor("· live");
    session.active("software")?.options.onEvent(daemonState("draining", 51));
    await ui.waitFor("Daemon stopping – will reconnect");
    session.setState("reconnecting");
    const frame = await ui.waitFor("OFFLINE since");
    expect(frame).not.toContain("draining");
    expect(frame).not.toContain("Daemon stopping");
    await ui.press("o");
    expect(await ui.waitFor("Offices")).toContain("Offices · offline");
  });

  it("shows view reloaded (history gap) once after stream.resetRequired", async () => {
    const { ui, session } = await open();
    await ui.waitFor("· live");
    const stream = session.active(`office:${OFFICES.dipsaus}`);
    stream!.active = false;
    stream?.options.onEnded?.({ code: "stream.resetRequired", message: "gap", retryable: false });
    await ui.waitFor(RELOADED_NOTICE);
    // Any key dismisses it; an unbound one changes nothing else, so the frame comes with the
    // store's next batch (at most 100 ms later).
    await ui.press("x");
    const deadline = performance.now() + 1_000;
    while (ui.frame().includes(RELOADED_NOTICE) && performance.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(ui.frame()).not.toContain(RELOADED_NOTICE);
  });
});

describe("quitting", () => {
  it("quits on a second q within 2 s", async () => {
    const { ui, clock, quits } = await open();
    await ui.press("q");
    await ui.waitFor("press q again to quit");
    clock.advance(1_900);
    await ui.press("q");
    expect(quits()).toBe(1);
  });

  it("does not quit when the second q comes after 2 s", async () => {
    const { ui, clock, quits } = await open();
    await ui.press("q");
    clock.advance(2_100);
    await ui.press("q");
    expect(quits()).toBe(0);
    await ui.press("q");
    expect(quits()).toBe(1);
  });

  it("quits on Ctrl+C", async () => {
    const { ui, quits } = await open();
    await ui.press("ctrl-c");
    expect(quits()).toBe(1);
  });
});

describe("terminal size and display", () => {
  it("shows one list with widen for detail below 60 columns", async () => {
    const { ui } = await open({ columns: 59, rows: 30 });
    const frame = await ui.waitFor("widen for detail");
    expect(frame).toContain("DIPO-21 busy >");
    expect(frame).toContain("desk 2");
    expect(frame).not.toContain("STORY");
  });

  it("shows one list below 16 rows and the full view after a resize", async () => {
    const { ui } = await open({ columns: 100, rows: 15 });
    await ui.waitFor("widen for detail");
    ui.resize(100, 30);
    const frame = await ui.waitFor("RUNNING (3)");
    expect(frame).not.toContain("widen for detail");
  });

  it("--ascii writes only ASCII", async () => {
    const { ui, session } = await open({ display: { color: true, ascii: true } });
    await ui.waitFor("dipsaus-orchestrator - daemon running - live");
    session.setState("reconnecting");
    const frame = await ui.waitFor("OFFLINE since");
    expect(frame).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
