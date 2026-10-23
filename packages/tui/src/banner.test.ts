// The daemon banner lines (0009 section 7, DIPO-120): the database line of a daemon held in
// `recovering` replaces the reconcile line, and the ordinary recovering banner is unchanged.

import { describe, expect, it } from "bun:test";

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";

import { bannerLines } from "./views";

function state(patch: Partial<OfficeStoreState>): OfficeStoreState {
  return {
    connection: "open",
    offlineSince: null,
    live: true,
    daemon: "recovering",
    engine: "0.1.0",
    capabilities: [],
    offices: [],
    office: null,
    loading: false,
    stories: [],
    work: [],
    gates: [],
    questions: [],
    tests: [],
    cursor: null,
    snapshots: 0,
    notice: null,
    error: null,
    database: null,
    ...patch,
  } as OfficeStoreState;
}

describe("daemon banner (DIPO-120)", () => {
  it("keeps the reconcile line for an ordinary recovering daemon", () => {
    expect(bannerLines(state({}), false)).toEqual([
      "Daemon recovering – office data after reconcile",
    ]);
  });

  it("shows the database reason and the newest backup in place of the reconcile line", () => {
    const lines = bannerLines(
      state({ database: { reason: "damaged", backup: "/s/backups/pre-v3.db" } }),
      false,
    );
    expect(lines).toEqual([
      "Database unavailable – reason: damaged; newest backup /s/backups/pre-v3.db",
    ]);
  });

  it("shows the reason alone when there is no backup", () => {
    expect(bannerLines(state({ database: { reason: "migration" } }), false)).toEqual([
      "Database unavailable – reason: migration",
    ]);
  });

  it("writes the database line in ASCII", () => {
    const lines = bannerLines(
      state({ database: { reason: "tooNew", backup: "/s/backups/pre-v3.db" } }),
      true,
    );
    expect(lines).toEqual([
      "Database unavailable - reason: tooNew; newest backup /s/backups/pre-v3.db",
    ]);
    expect(
      lines
        .join("")
        .split("")
        .every((char) => char.charCodeAt(0) < 128),
    ).toBe(true);
  });

  it("keeps the ASCII reconcile line in ASCII", () => {
    expect(bannerLines(state({}), true)).toEqual([
      "Daemon recovering - office data after reconcile",
    ]);
  });
});
