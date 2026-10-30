// The daemon lock (0005) on a real directory with real SQLite locks and a fake process table: who
// holds it, what a starter that cannot take it reports, the symbolic link refusal, the fail-closed
// cases, and release. One process holds two connections here; `lock-processes.test.ts` runs the
// starters as separate processes.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  acquireLock,
  formatPidRecord,
  LOCK_FILE,
  LockFileError,
  parsePidRecord,
  PID_FILE,
  type AcquireLockOptions,
  type HeldLock,
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
const lockPath = (dir: string) => join(dir, LOCK_FILE);
const readRecord = (dir: string) => parsePidRecord(readFileSync(pidPath(dir), "utf8"));
const writeRecord = (dir: string, record: PidRecord) =>
  writeFileSync(pidPath(dir), formatPidRecord(record));
const readIfAny = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

async function held(dir: string, self: PidRecord = SELF): Promise<HeldLock> {
  const outcome = await acquireLock(options(dir, new Map(), { self }));
  if (outcome.kind !== "acquired") throw new Error(`expected acquired, got ${outcome.kind}`);
  return outcome.lock;
}

/** Runs `fn` with `OTHER` holding the lock on a second connection, as a running daemon would. */
async function whileOtherHolds(dir: string, fn: () => Promise<void>): Promise<void> {
  const other = await held(dir, OTHER);
  try {
    await fn();
  } finally {
    other.release();
  }
}

describe("acquireLock", () => {
  it("takes dipo.lock and writes dipo.pid with mode 0600, leaving no journal file", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      expect(readRecord(dir)).toEqual(SELF);
      expect(statSync(pidPath(dir)).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).toSorted()).toEqual([LOCK_FILE, PID_FILE]);
      lock.release();
    });
  });

  it("overwrites an old record of a dead process without judging it: the lock is free", async () => {
    await withTempDir(async (dir) => {
      writeRecord(dir, OTHER);
      const opts = options(dir, new Map());
      const outcome = await acquireLock(opts);
      expect(outcome.kind).toBe("acquired");
      expect(readRecord(dir)).toEqual(SELF);
      expect(opts.log.lines.map((line) => line.message)).toEqual(["took the daemon lock"]);
      if (outcome.kind === "acquired") outcome.lock.release();
    });
  });

  it("reports a live daemon that holds the lock and answers its handshake", async () => {
    await withTempDir((dir) =>
      whileOtherHolds(dir, async () => {
        const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
        const outcome = await acquireLock(options(dir, table, { handshake: async () => true }));
        expect(outcome).toEqual({ kind: "running", record: OTHER });
        expect(readRecord(dir)).toEqual(OTHER);
      }),
    );
  });

  it("reports a live holder that stays silent as unresponsive after the wait, never taking it", async () => {
    await withTempDir((dir) =>
      whileOtherHolds(dir, async () => {
        const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
        const before = readFileSync(pidPath(dir), "utf8");
        const started = performance.now();
        const outcome = await acquireLock(options(dir, table, { waitMs: 80 }));
        expect(outcome).toEqual({ kind: "unresponsive", record: OTHER });
        expect(performance.now() - started).toBeGreaterThanOrEqual(75);
        expect(readFileSync(pidPath(dir), "utf8")).toBe(before);
      }),
    );
  });

  it("reports a holder that starts answering during the wait as running", async () => {
    await withTempDir((dir) =>
      whileOtherHolds(dir, async () => {
        const table: Table = new Map([[OTHER.pid, daemonInfo(OTHER)]]);
        let calls = 0;
        const outcome = await acquireLock(
          options(dir, table, { waitMs: 1000, handshake: async () => ++calls > 3 }),
        );
        expect(outcome.kind).toBe("running");
      }),
    );
  });

  // dipo.pid deleted or replaced while a daemon runs: the lock still excludes the starter.
  for (const [name, change] of [
    ["deleted", (dir: string) => unlinkSync(pidPath(dir))],
    ["replaced by a dead process's record", (dir: string) => writeRecord(dir, SELF)],
    ["replaced by damage", (dir: string) => writeFileSync(pidPath(dir), "{")],
  ] as const) {
    it(`never takes a held lock when dipo.pid was ${name}`, async () => {
      await withTempDir((dir) =>
        whileOtherHolds(dir, async () => {
          change(dir);
          const before = readIfAny(pidPath(dir));
          const outcome = await acquireLock(
            options(dir, new Map(), { self: { ...SELF, pid: 3000 } }),
          );
          expect(outcome.kind).toBe("held");
          if (outcome.kind === "held") expect(outcome.path).toBe(lockPath(dir));
          expect(readIfAny(pidPath(dir))).toBe(before);
        }),
      );
    });
  }

  it("takes a lock that comes free during the wait", async () => {
    await withTempDir(async (dir) => {
      const other = await held(dir, OTHER);
      const outcome = acquireLock(options(dir, new Map(), { waitMs: 2000 }));
      await Bun.sleep(50);
      other.release();
      const taken = await outcome;
      expect(taken.kind).toBe("acquired");
      expect(readRecord(dir)).toEqual(SELF);
      if (taken.kind === "acquired") taken.lock.release();
    });
  });

  for (const [name, target] of [
    ["an existing file", "target"],
    ["a missing file", "missing"],
  ] as const) {
    it(`refuses a dipo.lock that is a symbolic link to ${name}`, async () => {
      await withTempDir(async (dir) => {
        if (target === "target") writeFileSync(join(dir, target), "");
        symlinkSync(join(dir, target), lockPath(dir));
        const outcome = acquireLock(options(dir, new Map()));
        await expect(outcome).rejects.toBeInstanceOf(LockFileError);
        await expect(outcome).rejects.toThrow("SQLITE_CANTOPEN");
        expect(existsSync(pidPath(dir))).toBe(false);
        expect(existsSync(join(dir, "missing"))).toBe(false);
        if (target === "target") expect(statSync(join(dir, target)).size).toBe(0);
      });
    });
  }

  it("takes the lock through a state folder whose path holds a symbolic link", async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "real");
      mkdirSync(real);
      symlinkSync(real, join(dir, "state"));
      const lock = await held(join(dir, "state"));
      expect(existsSync(lockPath(real))).toBe(true);
      lock.release();
    });
  });
});

/** A start against `stateDir` that must fail closed: an error with `code`, and no `dipo.pid`. */
async function expectRefused(stateDir: string, code: string): Promise<void> {
  const outcome = acquireLock(options(stateDir, new Map()));
  await expect(outcome).rejects.toBeInstanceOf(LockFileError);
  await expect(outcome).rejects.toThrow(`(${code})`);
  expect(existsSync(pidPath(stateDir))).toBe(false);
}

// Fail-closed (0005): a lock file that cannot be created or locked stops the start.
describe("acquireLock when the lock file cannot be used", () => {
  it("refuses a read-only state folder without a lock file", async () => {
    await withTempDir(async (dir) => {
      const state = join(dir, "state");
      mkdirSync(state, { mode: 0o500 });
      try {
        await expectRefused(state, "SQLITE_CANTOPEN");
      } finally {
        chmodSync(state, 0o700);
      }
    });
  });

  it("refuses a read-only lock file, whose SQLite lock would exclude nobody", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(lockPath(dir), "", { mode: 0o400 });
      await expectRefused(dir, "SQLITE_READONLY");
    });
  });

  it("refuses a folder at the lock file's path", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(lockPath(dir));
      await expectRefused(dir, "SQLITE_CANTOPEN");
    });
  });

  it("refuses a lock file that is not a database", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(lockPath(dir), "not a database, ".repeat(16));
      await expectRefused(dir, "SQLITE_NOTADB");
    });
  });
});

describe("held lock", () => {
  it("records the runtime directory in dipo.pid", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      lock.setRuntimeDir("/tmp/dipo-501");
      expect(readRecord(dir)).toEqual({ ...SELF, runtimeDir: "/tmp/dipo-501" });
      expect(lock.record()).toEqual({ ...SELF, runtimeDir: "/tmp/dipo-501" });
      expect(readdirSync(dir).toSorted()).toEqual([LOCK_FILE, PID_FILE]);
      lock.release();
    });
  });

  it("removes dipo.pid and frees the lock on release, keeping the lock file", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      lock.release();
      expect(existsSync(pidPath(dir))).toBe(false);
      expect(existsSync(lockPath(dir))).toBe(true);
      const next = await held(dir, OTHER);
      expect(readRecord(dir)).toEqual(OTHER);
      next.release();
    });
  });

  it("releases when dipo.pid is already gone", async () => {
    await withTempDir(async (dir) => {
      const lock = await held(dir);
      unlinkSync(pidPath(dir));
      lock.release();
      (await held(dir)).release();
    });
  });
});
