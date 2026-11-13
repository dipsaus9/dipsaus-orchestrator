// The header and the daemon states (0009, DIPO-120, DIPO-458): `dipo / <office>`, `+N elsewhere · O`
// when other offices need the maintainer, the daemon chip, spend today from `office.summary` and
// the time, and nothing else; the daemon chip for each connection and daemon state; and the daemon
// screen that replaces the body when the daemon stopped or its database is unavailable.

import { describe, expect, it } from "bun:test";

import type { OfficeEntry, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { OfficeId, OfficeSummary } from "@dipsaus-orchestrator/contract";

import { daemonScreen, daemonScreenKeys } from "./states";
import { daemonChip, fitHeader, headerLine, headerText, officeCells, roomsText } from "./views";

const NOW = new Date(2026, 10, 8, 10, 42).getTime();
const A = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0O0A" as OfficeId;
const B = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0O0B" as OfficeId;
const C = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0O0C" as OfficeId;

function summary(office: OfficeId, name: string, patch: Partial<OfficeSummary> = {}): OfficeEntry {
  return {
    office,
    name,
    summary: {
      office,
      name,
      path: `/repos/${name}`,
      running: 0,
      parked: 0,
      waitingOnMaintainer: 0,
      ready: 0,
      ...patch,
    },
  } as OfficeEntry;
}

function state(patch: Partial<OfficeStoreState> = {}): OfficeStoreState {
  return {
    connection: "open",
    offlineSince: null,
    live: true,
    daemon: "running",
    engine: "0.1.0",
    offices: [
      summary(A, "dipsaus-orchestrator", {
        waitingOnMaintainer: 6,
        privacy: [],
        optIns: ["privacy.storeCommandBodies"],
        dayUsage: { tokens: 1200, alert: false, estimatedCost: 19.14 },
      }),
      summary(B, "backlog-site", { waitingOnMaintainer: 2 }),
    ],
    office: A,
    loading: false,
    stories: [],
    work: [],
    gates: [],
    questions: [],
    tests: [],
    planning: null,
    cursor: null,
    snapshots: 0,
    notice: null,
    error: null,
    streamError: null,
    database: null,
    ...patch,
  } as OfficeStoreState;
}

describe("the header", () => {
  it("shows dipo / office, +N elsewhere · O, the daemon dot and word, spend today and the time only", () => {
    const text = headerText(state(), false, NOW);
    expect(text).toEqual({
      left: "dipo / dipsaus-orchestrator",
      elsewhere: "   +2 elsewhere · O",
      plan: "",
      right: "● daemon live    $19.14 today    10:42",
    });
    const line = headerLine(text, 112);
    expect(line).toHaveLength(112);
    // The privacy words left the header (DIPO-458): they live in the settings.
    expect(line).not.toContain("stores");
    expect(line).not.toContain("privacy");
  });

  it("reads spend today from office.summary's dayUsage.estimatedCost, and leaves it out when unknown", () => {
    const unknown = state({
      offices: [summary(A, "dipsaus-orchestrator", { dayUsage: { tokens: 50, alert: false } })],
    });
    expect(headerText(unknown, false, NOW).right).toBe("● daemon live    10:42");
    const quiet = state({
      offices: [summary(A, "dipsaus-orchestrator", { dayUsage: { tokens: 0, alert: false } })],
    });
    expect(headerText(quiet, false, NOW).right).toBe("● daemon live    $0.00 today    10:42");
  });

  it("says nothing about elsewhere when no other office needs the maintainer", () => {
    const alone = state({ offices: [summary(A, "dipsaus-orchestrator"), summary(B, "b")] });
    expect(headerText(alone, false, NOW).elsewhere).toBe("");
  });

  it("sums today's spend over every office on Offices", () => {
    const offices = state({
      offices: [
        summary(A, "a", { dayUsage: { tokens: 9, alert: false, estimatedCost: 20 } }),
        summary(B, "b", { dayUsage: { tokens: 9, alert: false, estimatedCost: 7.1 } }),
        summary(C, "c"),
      ],
    });
    expect(headerText(offices, false, NOW, "Offices")).toEqual({
      left: "dipo / Offices",
      elsewhere: "",
      plan: "",
      right: "● daemon live    $27.10 today, all offices    10:42",
    });
  });
});

describe("the header while a planning session is open (DIPO-459)", () => {
  it("shows ● plan open at the right, before the daemon chip, and drops it before the chip", () => {
    const text = headerText(state(), false, NOW, undefined, true);
    expect(text.plan).toBe("● plan open    ");
    expect(headerLine(text, 112)).toMatch(
      / {3}● plan open {4}● daemon live {4}\$19\.14 today {4}10:42$/,
    );
    expect(headerLine(text, 112)).toHaveLength(112);
    const narrow = fitHeader(text, "● daemon live", 60, "…");
    expect(narrow.plan).toBe("");
    expect(narrow.right).toBe("● daemon live");
  });
});

describe("the header on a narrow terminal", () => {
  it("drops spend and the time first, then shortens the office name, and keeps the daemon chip", () => {
    const text = headerText(state(), false, NOW);
    const live = "● daemon live";
    expect(headerLine(fitHeader(text, live, 80, "…"), 80)).toBe(
      `dipo / dipsaus-orchestrator   +2 elsewhere · O${" ".repeat(21)}● daemon live`,
    );
    const narrow = fitHeader(text, live, 60, "…");
    expect(narrow.right).toBe(live);
    expect(narrow.left).toBe("dipo / dipsaus-orchestra…");
    expect(headerLine(narrow, 60)).toHaveLength(60);
  });
});

function chip(patch: Partial<OfficeStoreState>, ascii = false): string {
  const { glyph, word } = daemonChip(state(patch), ascii);
  return `${glyph} ${word}`;
}

describe("the daemon chip", () => {
  it("names each state with a glyph and a word", () => {
    expect(chip({})).toBe("● daemon live");
    expect(chip({ daemon: "recovering" })).toBe("◌ daemon recovering");
    expect(chip({ daemon: "starting" })).toBe("◌ daemon recovering");
    expect(chip({ daemon: "draining" })).toBe("◌ daemon stopping");
    expect(chip({ live: false })).toBe("◌ daemon catching up");
    expect(chip({ connection: "connecting" })).toBe("◌ connecting…");
    const since = new Date(2026, 10, 8, 13, 40).getTime();
    expect(chip({ connection: "reconnecting", offlineSince: since })).toBe(
      "✗ offline since 13:40 · view frozen",
    );
    expect(chip({ connection: "closed", offlineSince: since, daemon: "draining" })).toBe(
      "✗ daemon stopped",
    );
    expect(chip({ streamError: { code: "internal", message: "broke", retryable: false } })).toBe(
      "✗ stream ended: internal: broke",
    );
  });

  it("has an ASCII twin for every glyph", () => {
    expect(chip({}, true)).toBe("* daemon live");
    expect(chip({ daemon: "recovering" }, true)).toBe("~ daemon recovering");
    expect(chip({ connection: "reconnecting", offlineSince: NOW }, true)).toBe(
      "x offline since 10:42 - view frozen",
    );
  });

  it("drops spend and the time while offline, so frozen numbers do not read as live", () => {
    const offline = state({ connection: "reconnecting", offlineSince: NOW });
    expect(headerText(offline, false, NOW).right).toBe("✗ offline since 10:42 · view frozen");
  });
});

function keys(screen: "stopped" | "database", backup: boolean): string[] {
  return daemonScreenKeys(screen, backup).map((hint) => `${hint.key} ${hint.label}`);
}

describe("the daemon screens", () => {
  it("replaces the body when the daemon stopped or its database is unavailable, never for a plain reconcile", () => {
    expect(daemonScreen(state())).toBeNull();
    expect(daemonScreen(state({ daemon: "recovering" }))).toBeNull();
    expect(daemonScreen(state({ connection: "reconnecting", offlineSince: NOW }))).toBeNull();
    expect(
      daemonScreen(state({ connection: "closed", offlineSince: NOW, daemon: "draining" })),
    ).toBe("stopped");
    expect(daemonScreen(state({ daemon: "recovering", database: { reason: "migration" } }))).toBe(
      "database",
    );
  });

  it("gives each screen only its own keys", () => {
    expect(keys("stopped", false)).toEqual(["r restart daemon", "l open its log", "q q quit"]);
    expect(keys("database", true)).toEqual([
      "l open daemon log",
      "c copy the backup path",
      "q q quit",
    ]);
    expect(keys("database", false)).toEqual(["l open daemon log", "q q quit"]);
  });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("the rooms band and the Offices cells", () => {
  it("counts the rooms as the engine sent them", () => {
    expect(roomsText(state(), false)).toBe(
      "1 Desk 6    2 Floor 0    3 Queue 0·0    4 Retro    5 Plan    6 Roles",
    );
  });

  it("marks an office live, starts paused or idle N days from its summary (DIPO-458)", () => {
    const day = 86_400_000;
    const cells = (entry: OfficeEntry, open = false) => {
      const cell = officeCells(entry, open, NOW, false);
      return `${cell.glyph} ${cell.name}${cell.note}`;
    };
    expect(cells(summary(A, "dipsaus-orchestrator"), true)).toBe("● dipsaus-orchestrator · open");
    expect(cells(summary(B, "backlog-site", { startsPaused: true }))).toBe(
      "! backlog-site · starts paused",
    );
    expect(cells(summary(C, "notes-cli", { lastActivityAt: iso(NOW - 3 * day - 60_000) }))).toBe(
      "○ notes-cli · idle 3 days",
    );
    expect(cells(summary(C, "notes-cli", { lastActivityAt: iso(NOW - 3_600_000) }))).toBe(
      "● notes-cli",
    );
    expect(cells(summary(C, "notes-cli", { running: 1, lastActivityAt: iso(NOW - 9 * day) }))).toBe(
      "● notes-cli",
    );
  });
});
