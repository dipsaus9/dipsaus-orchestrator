// Render tests of the TUI (DIPO-53 test plan): the switcher from the golden event log, switching
// with `office.snapshot`, the offline and daemon banners, quitting, narrow terminals, `--ascii` and
// colour, and `n` through `office.open`. Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { RELOADED_NOTICE } from "@dipsaus-orchestrator/client";
import type { Event } from "@dipsaus-orchestrator/contract";

import { OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

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
    cursor: { stream: "software", seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "daemon.state",
    data: { from: "running", to },
  } as Event;
}

describe("office switcher", () => {
  it("lists the three offices of the golden event log; arrows and Enter select one", async () => {
    const { ui, session, store } = await open();
    await ui.waitFor("dipo / dipsaus-orchestrator");
    await ui.press("O");
    const frame = await ui.waitFor("slaydoku");
    expect(frame).toContain("dipo / Offices");
    // Offices (S2e): NEEDS YOU first after the name, RUNNING, READY and the TODAY bar.
    const lines = frame.split("\n").map((line) => line.trimEnd());
    const at = lines.findIndex((line) => line.startsWith("    OFFICE"));
    expect(lines.slice(at, at + 6)).toEqual([
      `    ${"OFFICE".padEnd(41)}NEEDS YOU   RUNNING   READY   TODAY`,
      `▌ ● ${"dipsaus-orchestrator · open".padEnd(41)}2           3         2`,
      `  ● ${"couchcade".padEnd(41)}0           0         1`,
      `  ● ${"slaydoku".padEnd(41)}1           1         0       ${"━".repeat(12)} 84% ALERT`,
      "",
      "  + a  open a repository path…",
    ]);
    expect(lines.at(-1)).toMatch(/^↑↓ move {3}⏎ open {3}a new path +esc back {3}q q quit$/);

    await ui.press("down");
    await ui.press("down");
    await ui.waitFor("▌ ● slaydoku");
    await ui.press("up");
    await ui.waitFor("▌ ● couchcade");
    await ui.press("down");
    await ui.press("enter");
    const opened = await ui.waitFor("dipo / slaydoku");
    expect(opened).toContain("SLAY-9");
    expect(opened).toContain("looping @");

    // Enter sent the read office.snapshot; the store left the old stream and follows the new one
    // after the cursor the read returned (0005).
    // The overview reads the new office's output tails and its digest after it (DIPO-81).
    const reads = session.reads.filter(
      (read) => read.name !== "work.outputRange" && read.name !== "office.digest",
    );
    expect(reads.at(-1)).toEqual({
      name: "office.snapshot",
      args: { office: OFFICES.slaydoku },
    });
    expect(session.active(`office:${OFFICES.dipsaus}`)).toBeUndefined();
    expect(session.active(`office:${OFFICES.slaydoku}`)?.after).toEqual({
      stream: `office:${OFFICES.slaydoku}`,
      seq: 12,
    });
    expect(store.state.office).toBe(OFFICES.slaydoku);
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["SLAY-9"]);
  });

  it("marks the focused office only by the focus bar under NO_COLOR, and by > under --ascii", async () => {
    for (const [display, bar] of [
      [{ color: false, ascii: false }, "▌"],
      [{ color: false, ascii: true }, ">"],
    ] as const) {
      const { ui } = await open({ display });
      await ui.waitFor("daemon live");
      await ui.press("O");
      const frame = await ui.waitFor("slaydoku");
      const rows = frame
        .split("\n")
        .filter((line) =>
          /(orchestrator · open|orchestrator - open|couchcade|slaydoku) +\d/.test(line),
        );
      expect(rows.map((line) => line.slice(0, 2))).toEqual([`${bar} `, "  ", "  "]);
    }
  });

  it("narrows the office column on a narrow terminal and keeps the TODAY bar with its alert (DIPO-81)", async () => {
    const { ui } = await open({ columns: 100, rows: 30 });
    await ui.waitFor("daemon live");
    await ui.press("O");
    const frame = await ui.waitFor("slaydoku");
    expect(frame).toContain(
      `  ● ${"slaydoku".padEnd(41)}1           1         0       ${"━".repeat(12)} 84% ALERT`,
    );
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("shows READY as ? for a summary without it, and q q quit at every width", async () => {
    for (const columns of [120, 80, 70, 60]) {
      const { ui, session } = await open({ columns, rows: 30 });
      await ui.waitFor("daemon live");
      session.active("software")?.options.onEvent({
        cursor: { stream: "software", seq: 60 },
        at: "2026-10-14T10:05:00.000Z",
        type: "office.summary",
        data: {
          office: OFFICES.couchcade,
          name: "couchcade",
          path: "/work/couchcade",
          running: 0,
          parked: 0,
          waitingOnMaintainer: 0,
        },
      } as Event);
      await ui.press("O");
      await ui.waitFor("couchcade");
      const deadline = performance.now() + 1_000;
      while (!/couchcade +0 +0 +\?/.test(ui.frame()) && performance.now() < deadline) {
        await Bun.sleep(5);
      }
      const frame = ui.frame();
      expect(frame).toMatch(/couchcade +0 +0 +\?/);
      expect(frame.split("\n").at(-1)).toContain("q q quit");
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("starts in the switcher when no office is open, and Esc does not leave it", async () => {
    const { ui } = await open({ office: null });
    await ui.waitFor("slaydoku");
    await ui.press("escape");
    expect(ui.frame()).toContain("Offices");
  });

  it("opens a new repository path with a through office.open, then switches to it", async () => {
    const { ui, session } = await open();
    session.opened.set("/work/slaydoku", OFFICES.slaydoku);
    await ui.press("O");
    await ui.waitFor("Offices");
    await ui.press("a");
    await ui.waitFor("+ path: _");
    await ui.press("/work/slaydokx");
    await ui.press("backspace");
    await ui.press("u");
    await ui.waitFor("+ path: /work/slaydoku_");
    await ui.press("enter");
    await ui.waitFor("dipo / slaydoku");
    expect(session.commands).toEqual([{ name: "office.open", args: { path: "/work/slaydoku" } }]);
  });

  it("shows why office.open failed and returns to the list", async () => {
    const { ui } = await open();
    await ui.press("O");
    await ui.press("a");
    await ui.press("/nowhere");
    await ui.press("enter");
    const frame = await ui.waitFor("office.notFound: not a repository");
    expect(frame).toContain("Offices");
  });
});

describe("connection and daemon states", () => {
  it("offline: freezes the body in shade, says what happened, and leaves only the reading keys", async () => {
    const { ui, session } = await open();
    await ui.waitFor("daemon live");
    session.setState("reconnecting");
    const frame = await ui.waitFor("offline since");
    // The test clock is at 10:04 UTC; the chip shows local time. The daemon state is unknown.
    expect(frame).toMatch(
      /^dipo \/ dipsaus-orchestrator {3}\+1 elsewhere · O +✗ offline since \d\d:\d\d · view frozen$/m,
    );
    expect(frame).not.toContain("daemon live");
    expect(frame).toContain("✗ Lost the daemon. Reconnecting…");
    expect(frame).toMatch(/What you see is from \d\d:\d\d\. Actions are off\./);
    expect(frame).toContain("The daemon keeps working if it's still up.");
    expect(frame.split("\n").at(-1)).toBe(
      "↑↓ move   ⏎ read   c copy id   q q quit   actions off while offline".replace(
        "c copy id   ",
        "",
      ),
    );
    // Values keep their last state, frozen in shade so they cannot be taken for live ones.
    expect(frame).toContain("DIPO-21");
    // oxlint-disable-next-line no-control-regex
    expect(ui.raw()).toMatch(/\u001b\[2m\u001b\[30m[^\n]*DIPO-21/);

    const snapshotReads = () => session.reads.filter((read) => read.name === "office.snapshot");
    const before = snapshotReads().length;
    await ui.press("O");
    await ui.press("down");
    await ui.press("enter");
    await ui.waitFor("offline: actions are disabled");
    expect(snapshotReads()).toHaveLength(before);
    await ui.press("a");
    expect(ui.frame()).not.toContain("+ path:");
  });

  it("shows recovering and stopping as header chips only, with the body as it was", async () => {
    const { ui, session } = await open();
    await ui.waitFor("daemon live");
    const software = session.active("software");
    software?.options.onEvent(daemonState("recovering", 50));
    const recovering = await ui.waitFor("◌ daemon recovering");
    // A plain reconcile has no body of its own.
    expect(recovering).toContain("RUNNING (3)");
    expect(recovering).not.toContain("Database unavailable");
    software?.options.onEvent(daemonState("draining", 51));
    await ui.waitFor("◌ daemon stopping");
    expect(session.commands).toEqual([]);
  });

  it("shows the database problem's body while the daemon is held in recovering, with l and c", async () => {
    const { ui, session, copied, daemonRequests } = await open();
    await ui.waitFor("daemon live");
    session.active("software")?.options.onEvent(daemonState("recovering", 50));
    await ui.waitFor("◌ daemon recovering");
    // The held daemon ends the office stream with database.unavailable (DIPO-111, DIPO-120).
    const stream = session.active(`office:${OFFICES.dipsaus}`);
    stream!.active = false;
    stream?.options.onEnded?.({
      code: "database.unavailable",
      message: "the state database is unavailable",
      retryable: true,
      details: { reason: "migration", backup: "/s/backups/pre-v4.db" },
    } as never);
    const frame = await ui.waitFor("Database unavailable");
    const lines = frame.split("\n").map((line) => line.trimEnd());
    const at = lines.findIndex((line) => line.includes("Database unavailable"));
    expect(lines.slice(at, at + 11)).toEqual([
      "  ! Database unavailable",
      "",
      "    reason  migration",
      "    backup  /s/backups/pre-v4.db",
      "",
      "    Stories and code are safe: they live in git.",
      "    Only run history is at stake.",
      "",
      "    l open daemon log   c copy the backup path",
      "    $ dipo daemon logs",
      lines[at + 10] ?? "",
    ]);
    expect(frame).not.toContain("RUNNING (3)");
    await ui.press("l");
    await ui.press("c");
    await ui.waitFor("copied /s/backups/pre-v4.db");
    expect(daemonRequests).toEqual(["log"]);
    expect(copied).toEqual(["/s/backups/pre-v4.db"]);
    // Only the screen's keys work: no view key reaches the office.
    await ui.press("3");
    expect(ui.frame()).not.toContain("next Ready story");
  });

  it("after a draining daemon goes away, shows daemon stopped with its body and keys", async () => {
    const { ui, session, daemonRequests } = await open();
    await ui.waitFor("daemon live");
    session.active("software")?.options.onEvent(daemonState("draining", 51));
    await ui.waitFor("◌ daemon stopping");
    session.setState("reconnecting");
    const frame = await ui.waitFor("✗ daemon stopped");
    const lines = frame.split("\n").map((line) => line.trimEnd());
    const at = lines.findIndex((line) => line.includes("The office manager"));
    expect(lines.slice(at, at + 6)).toEqual([
      "    ✗ The office manager isn't running.",
      "",
      "      No work is lost. Boxes pause until it's back.",
      expect.stringMatching(/^ {6}Last seen \d\d:\d\d$/) as unknown as string,
      "",
      "      r restart daemon    l open its log",
    ]);
    expect(lines.at(-1)).toMatch(/^r restart daemon {3}l open its log +q q quit$/);
    expect(frame).not.toContain("RUNNING (3)");
    await ui.press("r");
    await ui.waitFor("daemon started; reconnecting");
    expect(daemonRequests).toEqual(["restart"]);
  });

  it("shows view reloaded (history gap) once after stream.resetRequired", async () => {
    const { ui, session } = await open();
    await ui.waitFor("daemon live");
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
    // One q alone never quits.
    expect(quits()).toBe(0);
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
  it("asks to widen the terminal below 60 columns instead of the layout", async () => {
    const { ui } = await open({ columns: 59, rows: 30 });
    const frame = await ui.waitFor("Widen the terminal to at least 60 columns");
    expect(frame).not.toContain("STORY");
    expect(frame).not.toContain("DIPO-21");
  });

  it("asks to widen below 16 rows and shows the full view after a resize", async () => {
    const { ui } = await open({ columns: 100, rows: 15 });
    await ui.waitFor("Widen the terminal to at least 60 columns");
    ui.resize(100, 30);
    const frame = await ui.waitFor("RUNNING (3)");
    expect(frame).not.toContain("Widen the terminal");
  });

  it("--ascii writes only ASCII", async () => {
    const { ui, session } = await open({ display: { color: true, ascii: true } });
    await ui.waitFor("* daemon live");
    expect(ui.frame()).toMatch(/^[\x20-\x7e\n]*$/);
    session.setState("reconnecting");
    const frame = await ui.waitFor("offline since");
    expect(frame).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
