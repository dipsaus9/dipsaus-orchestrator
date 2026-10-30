// The PID lock (0005): steps 1 to 3 with a fake process table on a real directory, and release.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  acquireLock,
  formatPidRecord,
  LockBusyError,
  parsePidRecord,
  PID_FILE,
  type AcquireLockOptions,
  type PidRecord,
} from "../../src/platform/lock";
import { systemClock } from "../../src/platform/clock";
import type { ProcessInfo } from "../../src/platform/process";

const T0 = 1_791_535_923_000;
const SELF: PidRecord = { pid: 1000, startTimeMs: T0, version: "0.0.0-dev", runtimeDir: null };
const OTHER: PidRecord = {
  pid: 2000,
  startTimeMs: T0 - 60_000,
  version: "0.0.0-dev",
  runtimeDir: "/tmp/r",
};

type Table = Map<number, ProcessInfo>;

function daemonInfo(record: PidRecord, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: record.pid,
    startTimeMs: record.startTimeMs,
    zombie: false,
    command: "/usr/local/bin/dipo daemon --foreground",
    ...overrides,
  };
}

function logger() {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  return {
    lines,
    info: (message: string, fields?: unknown) => lines.push({ level: "info", message, fields }),
    warn: (message: string, fields?: unknown) => lines.push({ level: "warn", message, fields }),
  };
}

function options(
  stateDir: string,
  table: Table,
  overrides: Partial<AcquireLockOptions> = {},
): AcquireLockOptions & { log: ReturnType<typeof logger> } {
  const log = logger();
  return {
    stateDir,
    self: SELF,
    probe: async (pid) => table.get(pid) ?? null,
    clock: systemClock,
    handshake: async () => false,
    logger: log,
    log,
    waitMs: 60,
    pollMs: 10,
    ...overrides,
  };
}

const pidPath = (dir: string) => join(dir, PID_FILE);
const readRecord = (dir: string) => parsePidRecord(readFileSync(pidPath(dir), "utf8"));
const writeRecord = (dir: string, record: PidRecord) =>
  writeFileSync(pidPath(dir), formatPidRecord(record));

describe("acquireLock", () => {
  it("creates dipo.pid with mode 0600 when there is none", async () => {
    await withTempDir(async (dir) => {
      const outcome = await acquireLock(options(dir, new Map()));
      expect(outcome.kind).toBe("acquired");
      expect(readRecord(dir)).toEqual(SELF);
      expect(statSync(pidPath(dir)).mode & 0o777).toBe(0o600);
    });
  });

  it("reports a live daemon that answers its handshake (step 1)", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
      const outcome = await acquireLock(options(dir, table, { handshake: async () => true }));
      expect(outcome).toEqual({ kind: "running", record: OTHER });
      expect(readRecord(dir)).toEqual(OTHER);
    });
  });

  it("reports a live daemon that stays silent as unresponsive after the wait (step 1)", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
      const started = performance.now();
      const outcome = await acquireLock(options(dir, table, { waitMs: 80 }));
      expect(outcome).toEqual({ kind: "unresponsive", record: OTHER });
      expect(performance.now() - started).toBeGreaterThanOrEqual(75);
      // Code never kills or removes a live daemon's record on a guess.
      expect(readRecord(dir)).toEqual(OTHER);
    });
  });

  it("reports a daemon that starts answering during the wait as running", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
      let calls = 0;
      const outcome = await acquireLock(
        options(dir, table, { waitMs: 1000, handshake: async () => ++calls > 3 }),
      );
      expect(outcome.kind).toBe("running");
    });
  });

  for (const [name, table] of [
    ["a dead PID", new Map()],
    ["a zombie", new Map([[OTHER.pid, daemonInfo(OTHER, { zombie: true })]])],
    ["a reused PID", new Map([[OTHER.pid, daemonInfo(OTHER, { startTimeMs: T0 })]])],
    ["another command", new Map([[OTHER.pid, daemonInfo(OTHER, { command: "/usr/bin/vim" })]])],
  ] as const) {
    it(`deletes a stale record with ${name} and takes the lock`, async () => {
      await withTempDir(async (dir) => {
        writeRecord(dir, OTHER);
        const opts = options(dir, table as Table);
        const outcome = await acquireLock(opts);
        expect(outcome.kind).toBe("acquired");
        expect(readRecord(dir)).toEqual(SELF);
        expect(opts.log.lines.some((l) => l.message === "removed a stale daemon lock")).toBe(true);
        expect(readdirSync(dir)).toEqual([PID_FILE]);
      });
    });
  }

  it("deletes an unparsable record that stays unparsable for one poll", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(pidPath(dir), "");
      const outcome = await acquireLock(options(dir, new Map()));
      expect(outcome.kind).toBe("acquired");
      expect(readRecord(dir)).toEqual(SELF);
    });
  });

  it("goes back to step 1 once when another starter wins step 3, then reports it", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      const table: Table = new Map();
      let won = false;
      const opts = options(dir, table, {
        // The other starter answers once it holds the lock.
        handshake: async (record) => record.pid === 3000,
      });
      const outcome = await acquireLock({
        ...opts,
        logger: {
          info: opts.log.info,
          warn: (message, fields) => {
            opts.log.warn(message, fields);
            if (won) return;
            // Right after the stale record went, another starter creates its own.
            won = true;
            const winner = { ...OTHER, pid: 3000, startTimeMs: T0 };
            writeRecord(dir, winner);
            table.set(winner.pid, daemonInfo(winner));
          },
        },
      });
      expect(outcome).toEqual({
        kind: "running",
        record: { ...OTHER, pid: 3000, startTimeMs: T0 },
      });
    });
  });

  it("gives up when another starter wins step 3 twice", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      let next = 3000;
      const opts = options(dir, new Map());
      // Another starter writes a new record of a dead process right after every delete.
      const outcome = acquireLock({
        ...opts,
        logger: {
          info: opts.log.info,
          warn: (message, fields) => {
            opts.log.warn(message, fields);
            writeRecord(dir, { ...OTHER, pid: next++ });
          },
        },
      });
      await expect(outcome).rejects.toBeInstanceOf(LockBusyError);
      expect(next).toBe(3002);
    });
  });
});

async function held(dir: string, table: Table = new Map()) {
  const outcome = await acquireLock(options(dir, table));
  if (outcome.kind !== "acquired") throw new Error(`expected acquired, got ${outcome.kind}`);
  return outcome.lock;
}

describe("held lock", () => {
  it("records the runtime directory and still holds it", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      lock.setRuntimeDir("/tmp/dipo-501");
      expect(readRecord(dir)).toEqual({ ...SELF, runtimeDir: "/tmp/dipo-501" });
      expect(lock.holds()).toBe(true);
    });
  });

  it("leaves a record another process wrote alone on release", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      writeRecord(dir, OTHER);
      expect(lock.holds()).toBe(false);
      lock.release();
      expect(readRecord(dir)).toEqual(OTHER);
    });
  });

  it("removes only its own record on release", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      lock.release();
      expect(existsSync(pidPath(dir))).toBe(false);
    });
  });
});
