// `dipo config migrate` (0017) on a temp folder: it rewrites older office files at version 16 with
// their comments, names each key it moved or deleted, leaves a version 16 file alone, and refuses a
// file that would not load without touching it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { runConfigMigrateForm } from "./config-migrate";
import type { DaemonIo } from "./io";

function fakeIo(): { io: DaemonIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      writeLine: (line) => out.push(line),
      writeError: (line) => err.push(line),
      env: {},
      execArgv: [],
      version: "test",
      onShutdownSignal: () => () => {},
      clock: new ManualClock(),
    },
  };
}

function write(dir: string, name: string, text: string): string {
  mkdirSync(join(dir, ".dipo"), { recursive: true });
  const path = join(dir, ".dipo", name);
  writeFileSync(path, text);
  return path;
}

describe("dipo config migrate", () => {
  it("refuses an older file with the load's message and leaves both files untouched", () =>
    withTempDir(async (dir) => {
      const officeText = "# our office\nversion: 7\nmergeSlot:\n  ciAttempts: 3 # three tries\n";
      const localText = "version: 15\ntimeouts: { workerStallMinutes: 25 } # slow mac\n";
      const office = write(dir, "office.yaml", officeText);
      const local = write(dir, "office.local.yaml", localText);
      const { io, out, err } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(1);
      expect(out).toEqual([]);
      expect(readFileSync(office, "utf8")).toBe(officeText);
      expect(readFileSync(local, "utf8")).toBe(localText);
      expect(err).toEqual([
        "dipo: .dipo/office.yaml: version: configuration version 7 is older than this dipo reads (version 16), and this dipo has no upgrade from it: set version to 16, then fix the keys the next load names",
        "dipo: .dipo/office.yaml is left as it was",
        "dipo: .dipo/office.local.yaml: version: configuration version 15 is older than this dipo reads (version 16), and this dipo has no upgrade from it: set version to 16, then fix the keys the next load names",
        "dipo: .dipo/office.local.yaml is left as it was",
      ]);
    }));

  it("leaves a version 16 file as it is and says so", () =>
    withTempDir(async (dir) => {
      const text = "# mine\nversion: 16\nbase: main\n";
      const office = write(dir, "office.yaml", text);
      const { io, out } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(0);
      expect(readFileSync(office, "utf8")).toBe(text);
      expect(out).toEqual([".dipo/office.yaml: already version 16"]);
    }));

  it("refuses a file that would not load and leaves it untouched, still checking the other", () =>
    withTempDir(async (dir) => {
      const bad = "version: 16\ntimeouts: { workerStalMinutes: 5 }\n";
      const office = write(dir, "office.yaml", bad);
      const local = write(dir, "office.local.yaml", "version: 16\n");
      const { io, out, err } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(1);
      expect(readFileSync(office, "utf8")).toBe(bad);
      expect(err[0]).toContain(".dipo/office.yaml: timeouts.workerStalMinutes: unknown key");
      expect(err[0]).toContain("this key may need a newer dipo");
      expect(err.at(-1)).toBe("dipo: .dipo/office.yaml is left as it was");
      expect(readFileSync(local, "utf8")).toBe("version: 16\n");
      expect(out).toEqual([".dipo/office.local.yaml: already version 16"]);
    }));

  it("says when there is nothing to migrate, and refuses a missing folder argument", () =>
    withTempDir(async (dir) => {
      const { io, out, err } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(0);
      expect(out).toEqual(["no .dipo/office.yaml or .dipo/office.local.yaml to migrate"]);
      expect(await runConfigMigrateForm([], io)).toBe(2);
      expect(err[0]).toContain("usage: dipo config migrate");
    }));
});
