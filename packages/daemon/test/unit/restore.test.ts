// `dipo restore <file>` (DIPO-76): a `runDaemon` form that takes the daemon lock, refuses while a
// live daemon holds `dipo.pid` and names `dipo daemon stop`, and otherwise replaces `dipo.db` and
// releases the lock. The live daemon is stood in for by the lock outcome; the restore itself runs
// for real under the test's temp `DIPO_HOME`.

import { describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openStateDatabase } from "@dipsaus-orchestrator/engine";
import { createLogger, type LockOutcome, PID_FILE } from "@dipsaus-orchestrator/engine/platform";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { runDaemon } from "../../src/index";
import type { DaemonIo } from "../../src/io";
import { runRestoreForm } from "../../src/restore";

const clock = new ManualClock();

function testIo(dir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: DaemonIo = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    env: { DIPO_HOME: join(dir, "state") },
    execArgv: [],
    version: "0.0.0-test",
    onShutdownSignal: () => () => undefined,
    clock,
  };
  return { io, out, err };
}

/** A state database under `dir/state` and a closed copy of it as the backup. */
async function stateWithBackup(dir: string): Promise<{ live: string; backup: string }> {
  const state = await openStateDatabase({
    stateDir: join(dir, "state"),
    logger: createLogger({ clock, sinks: [], component: "test" }),
    clock,
    engineVersion: "0.0.0-test",
  });
  const live = state.connection.path;
  state.close();
  const backup = join(dir, "dipo-20261014.db");
  copyFileSync(live, backup);
  return { live, backup };
}

const live = (pid: number, kind: "running" | "unresponsive"): LockOutcome => ({
  kind,
  record: { pid, startTimeMs: 1, version: "0.1.0", runtimeDir: null },
});

describe("dipo restore", () => {
  it("refuses while a live daemon holds dipo.pid and names dipo daemon stop", () =>
    withTempDir(async (dir) => {
      const { live: path, backup } = await stateWithBackup(dir);
      writeFileSync(path, "damaged");
      for (const [kind, hint] of [
        ["running", "`dipo daemon stop`"],
        ["unresponsive", "`dipo daemon stop --force`"],
      ] as const) {
        const { io, out, err } = testIo(dir);
        const code = await runRestoreForm([backup], io, { acquire: async () => live(4242, kind) });
        expect(code).toBe(1);
        expect(out).toEqual([]);
        expect(err[0]).toContain("4242");
        expect(err[0]).toContain(hint);
        expect(readFileSync(path, "utf8")).toBe("damaged");
      }
    }));

  it("takes the lock, restores, and releases the lock", () =>
    withTempDir(async (dir) => {
      const { live: path, backup } = await stateWithBackup(dir);
      writeFileSync(path, "damaged");
      writeFileSync(`${path}-wal`, "stale");
      const { io, out, err } = testIo(dir);

      expect(await runDaemon(["restore", backup], io)).toBe(0);

      expect(err).toEqual([]);
      expect(out[0]).toBe(`restored ${backup} into ${path}`);
      expect(out[1]).toBe(
        "0 offices have a new epoch; clients reset their view when they reconnect",
      );
      expect(readFileSync(path, "utf8").startsWith("SQLite format 3")).toBe(true);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(join(dir, "state", PID_FILE))).toBe(false);
      const log = readFileSync(join(dir, "state", "logs", "daemon.log"), "utf8");
      expect(log).toContain("restored the state database");
    }));

  it("reports a damaged backup and restores nothing", () =>
    withTempDir(async (dir) => {
      const { live: path } = await stateWithBackup(dir);
      const before = readFileSync(path);
      const bad = join(dir, "bad.db");
      writeFileSync(bad, "not a database");
      const { io, err } = testIo(dir);
      expect(await runRestoreForm([bad], io)).toBe(1);
      expect(err[0]).toMatch(/is not a SQLite database.*Nothing was restored\.$/);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(existsSync(join(dir, "state", PID_FILE))).toBe(false);
    }));

  it("says plainly when dipo.db lost its WAL and logs it as an error", () =>
    withTempDir(async (dir) => {
      const { live: path, backup } = await stateWithBackup(dir);
      rmSync(path);
      mkdirSync(join(path, "blocker"), { recursive: true });
      writeFileSync(`${path}-wal`, "wal");
      const { io, out, err } = testIo(dir);
      expect(await runRestoreForm([backup], io)).toBe(1);
      expect(out).toEqual([]);
      expect(err[0]).toContain("has lost its most recent commits");
      expect(err[0]).not.toContain("Nothing was restored");
      const log = readFileSync(join(dir, "state", "logs", "daemon.log"), "utf8");
      expect(log).toContain('"level":"error"');
      expect(log).toContain("dipo.db lost its recent commits");
      expect(existsSync(join(dir, "state", PID_FILE))).toBe(false);
    }));

  it("needs exactly one file", () =>
    withTempDir(async (dir) => {
      for (const args of [[], ["a.db", "b.db"], ["--force"]]) {
        const { io, err } = testIo(dir);
        expect(await runRestoreForm(args, io)).toBe(2);
        expect(err[0]).toContain("usage: dipo restore <file>");
      }
    }));
});
