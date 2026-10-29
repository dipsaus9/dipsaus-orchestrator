// Autostart (DIPO-63, 0006) with a fake `launchctl` and a temp home directory, so
// nothing reaches the real launchd or `~/Library/LaunchAgents`: the generated plist matches the
// golden file and carries the caller's `PATH` (AC #3, #7); `launchctl` uses `user/<uid>` where
// `gui/<uid>` is missing (AC #6); when installed, start, stop and restart go through launchd
// (AC #6). launchd is the only supervisor (0004).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  autostartReport,
  DaemonNotRunningError,
  daemonEnv,
  type DaemonSession,
  type DaemonStatusResult,
  installDaemon,
  installedProgram,
  launchdPlist,
  LIFECYCLE_TIMINGS,
  type LifecycleDeps,
  type ProcessInfo,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type SupervisorDeps,
  systemClock,
  uninstallDaemon,
} from "../../src/node/index";

const FIXTURES = join(import.meta.dir, "fixtures", "supervisor");
const PROGRAM: [string, ...string[]] = ["/usr/local/bin/dipo", "daemon", "--foreground"];
const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const UID = 501;
const DAEMON_PID = 4242;
const START = 1_767_000_000_000;
const DAEMON_INFO: ProcessInfo = {
  pid: DAEMON_PID,
  startTimeMs: START,
  zombie: false,
  command: "/usr/local/bin/dipo daemon --foreground",
};

/** Timers fire on the next turn and move `now` to their due time. */
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

function status(): DaemonStatusResult {
  return {
    state: "running",
    pid: DAEMON_PID,
    version: "0.0.0-dev",
    uptimeMs: 1,
    socket: "/run/dipo.sock",
    loadedOffices: [],
    activeRuns: 0,
    keepAwake: { held: false },
    upgradePending: false,
    tools: {},
  };
}

function session(): DaemonSession {
  return {
    hello: null,
    read: (async () => ({ ok: true, result: status() })) as DaemonSession["read"],
    command: (async () => ({
      ok: true,
      result: { state: "draining" },
      changed: true,
    })) as DaemonSession["command"],
    subscribe: () => {
      throw new Error("subscribe must not be called");
    },
    close: () => {},
  };
}

interface Machine {
  readonly deps: LifecycleDeps;
  readonly supervisor: SupervisorDeps;
  readonly commands: string[];
  readonly spawns: unknown[];
  running: boolean;
}

/**
 * A fake machine: `launchctl` starts the daemon (writing its lock and runtime file) or stops it;
 * `gui` says whether the GUI launchd domain exists.
 */
function machine(dir: string, options: { gui?: boolean; loaded?: boolean } = {}): Machine {
  const state = join(dir, "state");
  const home = join(dir, "home");
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  const commands: string[] = [];
  const spawns: unknown[] = [];
  let loaded = options.loaded ?? false;
  const start = () => {
    m.running = true;
    writeFileSync(
      join(state, "dipo.pid"),
      JSON.stringify({
        pid: DAEMON_PID,
        startTimeMs: START,
        version: "0.0.0-dev",
        runtimeDir: "/run",
      }),
    );
    writeFileSync(
      join(state, "runtime.json"),
      JSON.stringify({
        runtimeDir: "/run",
        socket: "/run/dipo.sock",
        pid: DAEMON_PID,
        startTimeMs: START,
        version: "0.0.0-dev",
      }),
    );
  };
  const stop = () => {
    m.running = false;
  };
  const supervisor: SupervisorDeps = {
    home,
    uid: UID,
    selfCommand: ["/usr/local/bin/dipo"],
    env: { PATH, DIPO_HOME: state },
    exec: async (cmd) => {
      const line = cmd.join(" ");
      commands.push(line);
      const ok = { code: 0, stdout: "", stderr: "" };
      const [tool, ...args] = cmd;
      if (tool === "launchctl") {
        if (args[0] === "print") {
          if (args[1] === `gui/${UID}`) return options.gui === false ? { ...ok, code: 113 } : ok;
          return loaded ? ok : { ...ok, code: 113 };
        }
        if (args[0] === "bootstrap") {
          loaded = true;
          start();
        }
        if (args[0] === "kickstart") start();
        if (args[0] === "bootout") {
          if (!loaded) return { ...ok, code: 3, stderr: "Boot-out failed: 3: No such process" };
          loaded = false;
          stop();
        }
        return ok;
      }
      return { code: 127, stdout: "", stderr: "not found" };
    },
  };
  const m: Machine = {
    supervisor,
    commands,
    spawns,
    running: false,
    deps: {
      env: { DIPO_HOME: state, PATH },
      clock: new FastClock(),
      probe: async (pid) => (m.running && pid === DAEMON_PID ? DAEMON_INFO : null),
      signal: () => {
        throw new Error("no signal is sent under a supervisor");
      },
      spawn: async (spawn) => {
        spawns.push(spawn);
        return { pid: 999 };
      },
      selfCommand: ["/usr/local/bin/dipo"],
      connect: async () => {
        if (!m.running) throw new DaemonNotRunningError(state, "not running");
        return session();
      },
      timings: LIFECYCLE_TIMINGS,
      supervisor,
    },
  };
  return m;
}

describe("generated plist", () => {
  it("matches the golden file, with the binary's absolute path and the caller's PATH", () => {
    const options = { program: PROGRAM, path: PATH };
    expect(launchdPlist(options)).toBe(readFileSync(join(FIXTURES, "dipo.daemon.plist"), "utf8"));
  });

  it("escapes paths with spaces and XML characters, and reads the binary back", () => {
    const program: [string, ...string[]] = ["/Users/a b/bin/dipo&co", "daemon", "--foreground"];
    const plist = launchdPlist({ program, path: "/a b/<x>:/usr/bin" });
    expect(plist).toContain("<string>/Users/a b/bin/dipo&amp;co</string>");
    expect(plist).toContain("<string>/a b/&lt;x&gt;:/usr/bin</string>");
    expect(installedProgram(plist)).toBe("/Users/a b/bin/dipo&co");
    expect(installedProgram("[Service]\nExecStart=/usr/local/bin/dipo daemon\n")).toBeNull();
  });
});

describe("dipo daemon install", () => {
  it("writes the launch agent, bootstraps it in gui/<uid> and waits for the daemon", () =>
    withTempDir(async (dir) => {
      const m = machine(dir);
      const result = await installDaemon(m.deps);
      const file = join(dir, "home", "Library", "LaunchAgents", "dipo.daemon.plist");
      expect(result).toMatchObject({
        kind: "installed",
        file,
        stopped: null,
        start: { kind: "started", pid: DAEMON_PID },
      });
      expect(readFileSync(file, "utf8")).toBe(launchdPlist({ program: PROGRAM, path: PATH }));
      expect(m.commands).toContain(`launchctl bootstrap gui/${UID} ${file}`);
      expect(m.spawns).toEqual([]);
      expect(await autostartReport(m.supervisor)).toMatchObject({
        installed: true,
        file,
        program: "/usr/local/bin/dipo",
      });
    }));

  it("uses user/<uid> over SSH, where the gui domain is missing", () =>
    withTempDir(async (dir) => {
      const m = machine(dir, { gui: false });
      const result = await installDaemon(m.deps);
      expect(result.kind).toBe("installed");
      expect(m.commands.filter((c) => c.startsWith("launchctl bootstrap"))).toEqual([
        `launchctl bootstrap user/${UID} ${join(dir, "home", "Library", "LaunchAgents", "dipo.daemon.plist")}`,
      ]);
    }));

  it("stops a daemon running outside the supervisor first", () =>
    withTempDir(async (dir) => {
      const m = machine(dir);
      // A daemon from `dipo daemon start`: it drains on daemon.stop.
      m.running = true;
      writeFileSync(
        join(dir, "state", "dipo.pid"),
        JSON.stringify({
          pid: DAEMON_PID,
          startTimeMs: START,
          version: "0.0.0-dev",
          runtimeDir: "/run",
        }),
      );
      writeFileSync(
        join(dir, "state", "runtime.json"),
        JSON.stringify({
          runtimeDir: "/run",
          socket: "/run/dipo.sock",
          pid: DAEMON_PID,
          startTimeMs: START,
          version: "0.0.0-dev",
        }),
      );
      const deps: LifecycleDeps = {
        ...m.deps,
        connect: async () => {
          if (!m.running) throw new DaemonNotRunningError("/s", "not running");
          const s = session();
          return {
            ...s,
            command: (async () => {
              m.running = false;
              return { ok: true, result: { state: "draining" }, changed: true };
            }) as DaemonSession["command"],
          };
        },
      };
      const result = await installDaemon(deps);
      expect(result).toMatchObject({ kind: "installed", stopped: DAEMON_PID });
    }));
});

describe("start, stop and restart when installed", () => {
  it("go through launchctl: kickstart a loaded job, bootout to stop, bootstrap again", () =>
    withTempDir(async (dir) => {
      const m = machine(dir);
      expect((await installDaemon(m.deps)).kind).toBe("installed");
      m.commands.length = 0;

      expect(await stopDaemon(m.deps)).toEqual({ kind: "stopped", pid: DAEMON_PID, killed: false });
      expect(m.commands).toContain(`launchctl bootout gui/${UID}/dipo.daemon`);

      m.commands.length = 0;
      expect(await startDaemon(m.deps)).toMatchObject({ kind: "started", pid: DAEMON_PID });
      // Booted out, so start bootstraps it again.
      expect(m.commands.at(-1)).toMatch(/^launchctl bootstrap gui\/501 /);

      m.commands.length = 0;
      const restart = await restartDaemon(m.deps);
      expect(restart).toMatchObject({ kind: "restarted", stopped: DAEMON_PID });
      expect(m.commands).toContain(`launchctl bootout gui/${UID}/dipo.daemon`);
      expect(m.spawns).toEqual([]);
    }));

  it("kickstarts a loaded job that is not running", () =>
    withTempDir(async (dir) => {
      const m = machine(dir, { loaded: true });
      mkdirSync(join(dir, "home", "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(dir, "home", "Library", "LaunchAgents", "dipo.daemon.plist"), "x");
      expect(await startDaemon(m.deps)).toMatchObject({ kind: "started" });
      expect(m.commands.at(-1)).toBe(`launchctl kickstart gui/${UID}/dipo.daemon`);
    }));

  it("start spawns the daemon directly when nothing is installed", () =>
    withTempDir(async (dir) => {
      const m = machine(dir);
      await startDaemon(m.deps);
      expect(m.spawns).toHaveLength(1);
      expect(m.commands).toEqual([]);
    }));
});

describe("daemonEnv", () => {
  it("drops XPC_SERVICE_NAME, so a started daemon never looks like the launchd job", () => {
    expect(daemonEnv({ XPC_SERVICE_NAME: "dipo.daemon", PATH, BUN_OPTIONS: "--smol" })).toEqual({
      PATH,
    });
  });
});

describe("dipo daemon uninstall", () => {
  it("boots the job out, removes the plist and reports the stopped daemon", () =>
    withTempDir(async (dir) => {
      const m = machine(dir);
      await installDaemon(m.deps);
      const result = await uninstallDaemon(m.deps);
      expect(result).toMatchObject({ kind: "uninstalled", stopped: DAEMON_PID });
      expect(existsSync(join(dir, "home", "Library", "LaunchAgents", "dipo.daemon.plist"))).toBe(
        false,
      );
      expect(await uninstallDaemon(m.deps)).toMatchObject({ kind: "not installed" });
    }));
});
