// The `lifecycle` module (DIPO-70) over fake processes, a fake socket and a temp DIPO_HOME: stale
// `dipo.pid` and `runtime.json` (AC #9), autostart off and an invalid `config.yaml` spawning
// nothing (AC #2, #10), the daemon's environment without the Bun flag variables (AC #1, #11),
// `stop` with `daemon.stop` and `--force` against a verified PID only (AC #5) and `restart` across
// versions (AC #6, 0005). Time is a clock whose timers fire at once and move it forward.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Clock,
  detachedEnv,
  type ProcessInfo,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  AutostartOffError,
  connectOrStart,
  connectRunning,
  DaemonNotRunningError,
  type DaemonSession,
  type DaemonStatusResult,
  inspectDaemon,
  LIFECYCLE_TIMINGS,
  type LifecycleDeps,
  OtherVersionError,
  removeIfUnchanged,
  restartDaemon,
  SoftwareConfigError,
  type SpawnDaemonOptions,
  startDaemon,
  stopDaemon,
  systemClock,
  versionHint,
} from "../../src/node/index";

/** Timers fire on the next turn and move `now` to their due time, so 5 s waits take no time. */
class FastClock implements Clock {
  #now = 1_767_225_600_000;
  now(): number {
    return this.#now;
  }
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const due = this.#now + delayMs;
    return systemClock.setTimeout(() => {
      if (due > this.#now) this.#now = due;
      callback();
    }, 0);
  }
  clearTimeout(handle: TimerHandle): void {
    systemClock.clearTimeout(handle);
  }
}

const DAEMON_PID = 4242;
const START = 1_767_000_000_000;
const DAEMON_INFO: ProcessInfo = {
  pid: DAEMON_PID,
  startTimeMs: START,
  zombie: false,
  command: "/usr/local/bin/dipo daemon --foreground",
};

function status(pid = DAEMON_PID): DaemonStatusResult {
  return {
    state: "running",
    stateReason: "recovery finished",
    pid,
    version: "0.0.0-dev",
    uptimeMs: 1000,
    socket: "/run/dipo.sock",
    loadedOffices: [],
    activeRuns: 0,
    keepAwake: { held: false },
    upgradePending: false,
    tools: { git: "/usr/bin/git" },
  };
}

function session(options: { stop?: () => void; pid?: number } = {}): DaemonSession {
  return {
    hello: null,
    read: (async () => ({ ok: true, result: status(options.pid) })) as DaemonSession["read"],
    command: (async () => {
      options.stop?.();
      return { ok: true, result: { state: "draining" }, changed: true };
    }) as DaemonSession["command"],
    subscribe: () => {
      throw new Error("subscribe must not be called");
    },
    close: () => {},
  };
}

interface World {
  readonly deps: LifecycleDeps;
  readonly state: string;
  readonly procs: Map<number, ProcessInfo>;
  readonly signals: [number, string][];
  readonly spawns: SpawnDaemonOptions[];
}

function world(
  dir: string,
  options: {
    env?: Record<string, string>;
    connect?: (w: World) => Promise<DaemonSession>;
    onSignal?: (w: World, pid: number, signal: string) => void;
    onSpawn?: (w: World) => { pid: number };
  } = {},
): World {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  const procs = new Map<number, ProcessInfo>();
  const signals: [number, string][] = [];
  const spawns: SpawnDaemonOptions[] = [];
  const self: { w: World | null } = { w: null };
  const w: World = {
    state,
    procs,
    signals,
    spawns,
    deps: {
      env: { DIPO_HOME: state, ...options.env },
      clock: new FastClock(),
      probe: async (pid) => procs.get(pid) ?? null,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        options.onSignal?.(self.w!, pid, signal);
      },
      spawn: (spawn) => {
        spawns.push(spawn);
        return Promise.resolve(options.onSpawn?.(self.w!) ?? { pid: 999 });
      },
      selfCommand: ["/usr/local/bin/dipo"],
      connect: () =>
        options.connect === undefined
          ? Promise.reject(new DaemonNotRunningError(state, "no runtime.json"))
          : options.connect(self.w!),
      timings: LIFECYCLE_TIMINGS,
    },
  };
  self.w = w;
  return w;
}

function writeLock(state: string, info: { pid: number; startTimeMs: number } = DAEMON_INFO) {
  writeFileSync(
    join(state, "dipo.pid"),
    `${JSON.stringify({ pid: info.pid, startTimeMs: info.startTimeMs, version: "0.0.0-dev", runtimeDir: "/run" })}\n`,
  );
}

function writeRuntime(state: string, info: { pid: number; startTimeMs: number } = DAEMON_INFO) {
  writeFileSync(
    join(state, "runtime.json"),
    `${JSON.stringify({ runtimeDir: "/run", socket: "/run/dipo.sock", pid: info.pid, startTimeMs: info.startTimeMs, version: "0.0.0-dev" })}\n`,
  );
}

describe("inspectDaemon", () => {
  it("reports not running without any file", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      expect(await inspectDaemon(w.deps)).toEqual({ kind: "not running", cleaned: [] });
    }));

  it("treats runtime.json as stale when dipo.pid is missing, removes it, then reports not running", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      writeRuntime(w.state);
      expect(await inspectDaemon(w.deps)).toEqual({
        kind: "not running",
        cleaned: [join(w.state, "runtime.json")],
      });
      expect(existsSync(join(w.state, "runtime.json"))).toBe(false);
      expect(await inspectDaemon(w.deps)).toEqual({ kind: "not running", cleaned: [] });
    }));

  it("treats dipo.pid and runtime.json as stale for a dead PID and for a reused PID, and never deletes dipo.pid", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      writeLock(w.state);
      const lock = readFileSync(join(w.state, "dipo.pid"), "utf8");
      writeRuntime(w.state);
      expect(await inspectDaemon(w.deps)).toEqual({
        kind: "not running",
        cleaned: [join(w.state, "runtime.json")],
        staleLock: join(w.state, "dipo.pid"),
      });
      // The next daemon to take the lock overwrites it (0005): the client leaves it as it was.
      expect(readFileSync(join(w.state, "dipo.pid"), "utf8")).toBe(lock);
      expect(readdirSync(w.state).filter((name) => name.includes(".stale."))).toEqual([]);
      // The PID now belongs to another process that started later.
      w.procs.set(DAEMON_PID, { ...DAEMON_INFO, startTimeMs: START + 60_000 });
      writeLock(w.state);
      writeRuntime(w.state);
      const observed = await inspectDaemon(w.deps);
      expect(observed).toEqual({
        kind: "not running",
        cleaned: [join(w.state, "runtime.json")],
        staleLock: join(w.state, "dipo.pid"),
      });
      // And a PID with the right start time that is not `dipo daemon --foreground`.
      w.procs.set(DAEMON_PID, { ...DAEMON_INFO, command: "/bin/sleep 100" });
      writeLock(w.state);
      expect((await inspectDaemon(w.deps)).kind).toBe("not running");
      expect(existsSync(join(w.state, "dipo.pid"))).toBe(true);
    }));

  it("keeps a runtime.json whose own process is alive, even without dipo.pid", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeRuntime(w.state);
      expect(await inspectDaemon(w.deps)).toEqual({ kind: "not running", cleaned: [] });
      expect(existsSync(join(w.state, "runtime.json"))).toBe(true);
    }));

  it("reports running with daemon.status when the verified daemon answers", () =>
    withTempDir(async (dir) => {
      const w = world(dir, { connect: async () => session() });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      const observed = await inspectDaemon(w.deps);
      expect(observed.kind).toBe("running");
      expect(observed.kind === "running" && observed.status.tools).toEqual({ git: "/usr/bin/git" });
    }));

  it("reports unresponsive when the live daemon stays silent for 5 s", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: () => Promise.reject(new DaemonNotRunningError("/s", "silent")),
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      const before = w.deps.clock.now();
      expect((await inspectDaemon(w.deps)).kind).toBe("unresponsive");
      expect(w.deps.clock.now() - before).toBeGreaterThanOrEqual(LIFECYCLE_TIMINGS.startWaitMs);
    }));

  it("reports a daemon of another version as foreign with its version (0005)", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: () => Promise.reject(new OtherVersionError("2.0.0", "0.0.0-dev")),
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      expect(await inspectDaemon(w.deps)).toMatchObject({ kind: "foreign", version: "2.0.0" });
    }));
});

describe("removeIfUnchanged", () => {
  it("puts back a file that changed after it was read", () =>
    withTempDir((dir) => {
      const path = join(dir, "runtime.json");
      writeFileSync(path, "new");
      expect(removeIfUnchanged({ path, raw: "old" })).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(removeIfUnchanged({ path, raw: "new" })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(removeIfUnchanged({ path, raw: "new" })).toBe(false);
    }));
});

describe("startDaemon and autostart", () => {
  it("spawns dipo daemon --foreground with PATH kept and the Bun flag variables removed", () =>
    withTempDir(async (dir) => {
      let spawned = false;
      const w = world(dir, {
        env: {
          PATH: "/opt/tools/bin:/usr/bin",
          BUN_OPTIONS: "--no-orphans",
          BUN_FEATURE_FLAG_NO_ORPHANS: "1",
          OTHER: "kept",
        },
        connect: async () => {
          if (!spawned) throw new DaemonNotRunningError("/s", "not yet");
          return session({ pid: 999 });
        },
        onSpawn: () => {
          spawned = true;
          return { pid: 999 };
        },
      });
      expect(await startDaemon(w.deps, { logLevel: "debug" })).toEqual({
        kind: "started",
        pid: 999,
        version: "0.0.0-dev",
      });
      expect(w.spawns).toHaveLength(1);
      const [spawn] = w.spawns;
      expect(spawn?.cmd).toEqual([
        "/usr/local/bin/dipo",
        "daemon",
        "--foreground",
        "--log-level",
        "debug",
      ]);
      expect(spawn?.env["PATH"]).toBe("/opt/tools/bin:/usr/bin");
      expect(spawn?.env["OTHER"]).toBe("kept");
      expect(spawn?.env["BUN_OPTIONS"]).toBeUndefined();
      expect(spawn?.env["BUN_FEATURE_FLAG_NO_ORPHANS"]).toBeUndefined();
    }));

  it("removes BUN_OPTIONS and BUN_FEATURE_FLAG_NO_ORPHANS in detachedEnv", () => {
    expect(
      detachedEnv({
        PATH: "/bin",
        BUN_OPTIONS: "x",
        BUN_FEATURE_FLAG_NO_ORPHANS: "1",
        U: undefined,
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("reports a daemon that exits during its start, with the log directory", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      expect(await startDaemon(w.deps)).toEqual({
        kind: "exited",
        pid: 999,
        logs: join(w.state, "logs"),
      });
    }));

  it("gives up after 5 s without engine.hello", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      w.procs.set(999, { ...DAEMON_INFO, pid: 999 });
      expect(await startDaemon(w.deps)).toMatchObject({ kind: "timeout", pid: 999 });
    }));

  it("with daemon.autostart false fails naming dipo daemon start and spawns nothing", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      writeFileSync(join(w.state, "config.yaml"), "version: 1\ndaemon:\n  autostart: false\n");
      const error = await connectOrStart(w.deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AutostartOffError);
      expect((error as Error).message).toContain("`dipo daemon start`");
      expect(w.spawns).toEqual([]);
    }));

  it("shows config.yaml errors instead of starting a daemon that would exit 78", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      writeFileSync(join(w.state, "config.yaml"), "version: 1\ndaemon:\n  autostart: maybe\n");
      const error = await connectOrStart(w.deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SoftwareConfigError);
      expect((error as SoftwareConfigError).errors[0]?.message).toContain("daemon.autostart");
      expect(w.spawns).toEqual([]);

      writeFileSync(join(w.state, "config.yaml"), "version: 5\n");
      expect(await startDaemon(w.deps)).toMatchObject({ kind: "config" });
      expect(w.spawns).toEqual([]);
    }));

  it("starts the daemon for a command that needs it when autostart is on", () =>
    withTempDir(async (dir) => {
      let spawned = false;
      const w = world(dir, {
        connect: async () => {
          if (!spawned) throw new DaemonNotRunningError("/s", "not yet");
          return session({ pid: 999 });
        },
        onSpawn: () => {
          spawned = true;
          return { pid: 999 };
        },
      });
      const connected = await connectOrStart(w.deps);
      expect(connected.started).toEqual({ pid: 999, version: "0.0.0-dev" });
      expect(w.spawns).toHaveLength(1);
    }));

  it("connectRunning never starts the daemon: no daemon throws DaemonNotRunningError and spawns nothing", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: async () => {
          throw new DaemonNotRunningError("/s", "nothing answers");
        },
      });
      const error = await connectRunning(w.deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DaemonNotRunningError);
      expect(w.spawns).toEqual([]);
    }));

  it("connectRunning returns the session of a daemon that answers", () =>
    withTempDir(async (dir) => {
      const w = world(dir, { connect: async () => session({ pid: 999 }) });
      expect(await connectRunning(w.deps)).toBeDefined();
      expect(w.spawns).toEqual([]);
    }));
});

describe("stopDaemon", () => {
  it("sends daemon.stop and waits for the PID to exit", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: async (self) => session({ stop: () => self.procs.delete(DAEMON_PID) }),
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      expect(await stopDaemon(w.deps)).toEqual({ kind: "stopped", pid: DAEMON_PID, killed: false });
      expect(w.signals).toEqual([]);
    }));

  it("--force sends SIGTERM to the verified PID, then SIGKILL after 10 s, and cleans up", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: () => Promise.reject(new DaemonNotRunningError("/s", "silent")),
        onSignal: (self, pid, signal) => {
          if (signal === "SIGKILL") self.procs.delete(pid);
        },
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      const before = w.deps.clock.now();
      expect(await stopDaemon(w.deps, { force: true })).toEqual({
        kind: "stopped",
        pid: DAEMON_PID,
        killed: true,
      });
      expect(w.signals).toEqual([
        [DAEMON_PID, "SIGTERM"],
        [DAEMON_PID, "SIGKILL"],
      ]);
      expect(w.deps.clock.now() - before).toBeGreaterThanOrEqual(
        LIFECYCLE_TIMINGS.forceKillAfterMs,
      );
      // A killed daemon's record stays for the next daemon to overwrite (0005).
      expect(existsSync(join(w.state, "dipo.pid"))).toBe(true);
      expect(existsSync(join(w.state, "runtime.json"))).toBe(false);
    }));

  it("--force cleans the runtime.json a daemon leaves when SIGTERM ends it within 10 s", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: () => Promise.reject(new DaemonNotRunningError("/s", "silent")),
        onSignal: (self, pid) => {
          // The drain removes dipo.sock and dipo.pid, and leaves runtime.json behind.
          self.procs.delete(pid);
          rmSync(join(self.state, "dipo.pid"));
        },
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      expect(await stopDaemon(w.deps, { force: true })).toEqual({
        kind: "stopped",
        pid: DAEMON_PID,
        killed: false,
      });
      expect(w.signals).toEqual([[DAEMON_PID, "SIGTERM"]]);
      expect(existsSync(join(w.state, "runtime.json"))).toBe(false);
      expect(await inspectDaemon(w.deps)).toEqual({ kind: "not running", cleaned: [] });
    }));

  it("never signals a PID whose start time does not match dipo.pid", () =>
    withTempDir(async (dir) => {
      const w = world(dir);
      w.procs.set(DAEMON_PID, { ...DAEMON_INFO, startTimeMs: START + 3_600_000 });
      writeLock(w.state);
      expect(await stopDaemon(w.deps, { force: true })).toEqual({
        kind: "not running",
        cleaned: [],
        staleLock: join(w.state, "dipo.pid"),
      });
      expect(w.signals).toEqual([]);
      expect(existsSync(join(w.state, "dipo.pid"))).toBe(true);
    }));

  it("points an unresponsive daemon to --force without signalling it", () =>
    withTempDir(async (dir) => {
      const w = world(dir, {
        connect: () => Promise.reject(new DaemonNotRunningError("/s", "silent")),
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      expect(await stopDaemon(w.deps)).toEqual({ kind: "unresponsive", pid: DAEMON_PID });
      expect(w.signals).toEqual([]);
    }));
});

describe("restartDaemon", () => {
  it("uses the verified-PID SIGTERM for another version, then starts this binary", () =>
    withTempDir(async (dir) => {
      let spawned = false;
      const w = world(dir, {
        connect: async () => {
          if (spawned) return session({ pid: 999 });
          // An older daemon refuses this binary's hello: its version is not known.
          throw new OtherVersionError(null, "0.0.0-dev");
        },
        onSignal: (self, pid) => {
          self.procs.delete(pid);
          // A clean drain removes the daemon's own files.
          rmSync(join(self.state, "dipo.pid"));
          rmSync(join(self.state, "runtime.json"));
        },
        onSpawn: () => {
          spawned = true;
          return { pid: 999 };
        },
      });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      const result = await restartDaemon(w.deps);
      expect(result).toEqual({
        kind: "restarted",
        stopped: DAEMON_PID,
        start: { kind: "started", pid: 999, version: "0.0.0-dev" },
      });
      expect(w.signals).toEqual([[DAEMON_PID, "SIGTERM"]]);
    }));

  it("refuses before stopping anything when config.yaml is invalid", () =>
    withTempDir(async (dir) => {
      const w = world(dir, { connect: async () => session() });
      w.procs.set(DAEMON_PID, DAEMON_INFO);
      writeLock(w.state);
      writeRuntime(w.state);
      writeFileSync(join(w.state, "config.yaml"), "version: 9\n");
      expect(await restartDaemon(w.deps)).toMatchObject({ kind: "config" });
      expect(w.signals).toEqual([]);
      expect(w.spawns).toEqual([]);
    }));
});

describe("versionHint", () => {
  it("prints the 0006 decision 14 hint only when the versions differ", () => {
    expect(versionHint("0.2.0", "0.1.0")).toBe(
      "daemon runs v0.1.0, this binary is v0.2.0, run `dipo daemon restart`",
    );
    expect(versionHint("0.2.0", "0.2.0")).toBeNull();
    expect(versionHint("0.2.0", undefined)).toBeNull();
  });
});
