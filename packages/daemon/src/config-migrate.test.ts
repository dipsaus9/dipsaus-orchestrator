// `dipo config migrate` (0017) on a temp folder: it rewrites older office files at version 14 with
// their comments, names each key it moved or deleted, leaves a version 14 file alone, and refuses a
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
  it("rewrites both older files at version 14, keeping comments, and names each change", () =>
    withTempDir(async (dir) => {
      const office = write(
        dir,
        "office.yaml",
        "# our office\nversion: 7\nstoryPr: { open: true }\nmergeSlot:\n  ciAttempts: 3 # three tries\n",
      );
      const local = write(
        dir,
        "office.local.yaml",
        "version: 4\nsandbox: { toolchainReadPaths: [~/.nvm] }\ntimeouts: { workerStallMinutes: 25 } # slow mac\n",
      );
      const { io, out, err } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(0);
      expect(err).toEqual([]);
      expect(readFileSync(office, "utf8")).toBe(
        "# our office\nversion: 14\ncaps:\n  ciAttempts: 3 # three tries\n",
      );
      expect(readFileSync(local, "utf8")).toBe(
        "version: 14\ntimeouts: { workerStallMinutes: 25 } # slow mac\n",
      );
      expect(out).toEqual([
        ".dipo/office.yaml: version 7 to 14",
        "  moved mergeSlot.ciAttempts to caps.ciAttempts",
        "  deleted storyPr, because every story gets its PR: CI on it is the final gate (0002)",
        ".dipo/office.local.yaml: version 4 to 14",
        "  deleted sandbox, because the Mac sandbox is gone: the box is the boundary (0008)",
      ]);
    }));

  it("leaves a version 14 file as it is and says so", () =>
    withTempDir(async (dir) => {
      const text = "# mine\nversion: 14\nbase: main\n";
      const office = write(dir, "office.yaml", text);
      const { io, out } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(0);
      expect(readFileSync(office, "utf8")).toBe(text);
      expect(out).toEqual([".dipo/office.yaml: already version 14"]);
    }));

  it("refuses a file that would not load and leaves it untouched, still migrating the other", () =>
    withTempDir(async (dir) => {
      const bad = "version: 9\ntimeouts: { workerStalMinutes: 5 }\n";
      const office = write(dir, "office.yaml", bad);
      const local = write(dir, "office.local.yaml", "version: 3\n");
      const { io, out, err } = fakeIo();
      expect(await runConfigMigrateForm([dir], io)).toBe(1);
      expect(readFileSync(office, "utf8")).toBe(bad);
      expect(err[0]).toContain(".dipo/office.yaml: timeouts.workerStalMinutes: unknown key");
      expect(err[0]).toContain("this key may need a newer dipo");
      expect(err.at(-1)).toBe("dipo: .dipo/office.yaml is left as it was");
      expect(readFileSync(local, "utf8")).toBe("version: 14\n");
      expect(out).toEqual([".dipo/office.local.yaml: version 3 to 14"]);
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
