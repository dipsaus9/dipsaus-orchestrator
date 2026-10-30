// `dipo daemon start|stop|restart|status` (DIPO-70, 0006 decisions 5 and 14) over a fake
// lifecycle: the printed reports, `--json`, the exit codes 0, 1 and 3, and the restart hint.

import { describe, expect, it } from "bun:test";

import type {
  AutostartReport,
  DaemonObservation,
  InstallResult,
  UninstallResult,
  DaemonStatusResult,
  RestartResult,
  StartResult,
  StopResult,
} from "@dipsaus-orchestrator/client/node";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl } from "./daemon-commands";
import { fakeWorkspace } from "../test/support/fake-workspace";
import { main, type CliDeps } from "./index";

const VERSION = "0.0.0-dev";

const RECORD = { pid: 4242, startTimeMs: 1, version: VERSION, runtimeDir: "/run/dipo" };

const STATUS: DaemonStatusResult = {
  state: "running",
  stateReason: "recovery finished",
  pid: 4242,
  version: VERSION,
  uptimeMs: 3_725_000,
  socket: "/run/dipo/dipo.sock",
  loadedOffices: [],
  activeRuns: 0,
  keepAwake: { held: false },
  upgradePending: false,
  tools: {
    claude: "/opt/bin/claude",
    backlog: "/opt/bin/backlog",
    gh: "/opt/bin/gh",
    git: "/usr/bin/git",
  },
};

function need<T>(value: T | undefined, name: string): Promise<T> {
  return value === undefined
    ? Promise.reject(new Error(`${name} must not be called`))
    : Promise.resolve(value);
}

interface Calls {
  start: unknown[];
  stop: unknown[];
  restart: unknown[];
}

function fake(results: {
  inspect?: DaemonObservation;
  start?: StartResult;
  stop?: StopResult;
  restart?: RestartResult;
  install?: InstallResult;
  uninstall?: UninstallResult;
  autostart?: AutostartReport;
  configErrors?: { path: string; message: string }[];
}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Calls = { start: [], stop: [], restart: [] };
  const daemon: DaemonControl = {
    inspect: () => need(results.inspect, "inspect"),
    start: (options) => {
      calls.start.push(options);
      return need(results.start, "start");
    },
    stop: (options) => {
      calls.stop.push(options);
      return need(results.stop, "stop");
    },
    restart: (options) => {
      calls.restart.push(options);
      return need(results.restart, "restart");
    },
    install: () => need(results.install, "install"),
    uninstall: () => need(results.uninstall, "uninstall"),
    ...(results.autostart === undefined
      ? {}
      : { autostart: () => Promise.resolve(results.autostart ?? null) }),
    ...(results.configErrors === undefined
      ? {}
      : { configErrors: () => results.configErrors as never }),
  };
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      throw new Error("connectDaemon must not be called");
    },
    daemon,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: { version: VERSION, commit: "0123456789ab", commitDate: "2026-10-12" },
    runtime: { bun: "1.4.2", os: "darwin", arch: "arm64" },
    workspace: fakeWorkspace(),
  };
  return { deps, out, err, calls };
}

describe("dipo daemon status", () => {
  it("prints running with state, reason, PID, version, uptime, socket and tool paths; exit 0", async () => {
    const ctx = fake({ inspect: { kind: "running", record: RECORD, status: STATUS } });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      "running",
      "  state:      running (recovery finished)",
      "  pid:        4242",
      "  version:    0.0.0-dev",
      "  uptime:     1h 2m 5s",
      "  socket:     /run/dipo/dipo.sock",
      "  offices:    0 loaded, 0 active runs",
      "  keep-awake: not held",
      "  tools:",
      "    claude  /opt/bin/claude",
      "    backlog /opt/bin/backlog",
      "    gh      /opt/bin/gh",
      "    rg      missing",
      "    git     /usr/bin/git",
    ]);
    expect(ctx.err).toEqual([]);
  });

  it("shows upgrade pending and the restart hint for another daemon version", async () => {
    const status = { ...STATUS, version: "0.1.0", upgradePending: true };
    const ctx = fake({ inspect: { kind: "running", record: RECORD, status } });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out).toContain(
      "  upgrade pending: the binary changed on disk; run `dipo daemon restart`",
    );
    expect(ctx.err).toEqual([
      "dipo: daemon runs v0.1.0, this binary is v0.0.0-dev, run `dipo daemon restart`",
    ]);
  });

  it("prints not running with exit 3, and stale when leftovers were removed", async () => {
    const none = fake({ inspect: { kind: "not running", cleaned: [] } });
    expect(await main(["daemon", "status"], none.deps)).toBe(3);
    expect(none.out).toEqual(["not running"]);

    const stale = fake({
      inspect: {
        kind: "not running",
        cleaned: ["/state/runtime.json"],
        staleLock: "/state/dipo.pid",
      },
    });
    expect(await main(["daemon", "status"], stale.deps)).toBe(3);
    expect(stale.out).toEqual([
      "stale",
      "  removed leftovers of a daemon that is gone: /state/runtime.json",
      "  stale dipo.pid of a daemon that is gone, left for the next daemon to overwrite: /state/dipo.pid",
    ]);
  });

  it("prints unresponsive with exit 1 and points to stop --force", async () => {
    const ctx = fake({ inspect: { kind: "unresponsive", record: RECORD } });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(1);
    expect(ctx.out[0]).toBe("unresponsive");
    expect(ctx.out[1]).toContain("dipo daemon stop --force");
  });

  it("prints the same as JSON with --json and keeps the exit codes", async () => {
    const cases: [DaemonObservation, number, unknown][] = [
      [
        { kind: "running", record: RECORD, status: STATUS },
        0,
        { status: "running", daemon: STATUS },
      ],
      [{ kind: "unresponsive", record: RECORD }, 1, { status: "unresponsive", pid: 4242 }],
      [{ kind: "not running", cleaned: [] }, 3, { status: "not running" }],
      [
        { kind: "not running", cleaned: ["/state/runtime.json"] },
        3,
        { status: "stale", cleaned: ["/state/runtime.json"] },
      ],
      [
        { kind: "not running", cleaned: [], staleLock: "/state/dipo.pid" },
        3,
        { status: "stale", cleaned: [], staleLock: "/state/dipo.pid" },
      ],
    ];
    for (const [inspect, code, json] of cases) {
      const ctx = fake({ inspect });
      expect(await main(["daemon", "status", "--json"], ctx.deps)).toBe(code);
      expect(JSON.parse(ctx.out.join("\n"))).toEqual(json);
    }
  });

  it("reports a daemon of another version as running with the restart hint (0005)", async () => {
    const ctx = fake({ inspect: { kind: "foreign", record: RECORD, version: "2.0.0" } });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out[0]).toBe("running");
    expect(ctx.out[2]).toBe("  version:    2.0.0 (another version)");
    expect(ctx.err).toEqual([
      "dipo: daemon runs v2.0.0, this binary is v0.0.0-dev, run `dipo daemon restart`",
    ]);
  });

  it("rejects unknown options", async () => {
    const ctx = fake({});
    expect(await main(["daemon", "status", "--yaml"], ctx.deps)).toBe(2);
  });
});

describe("dipo daemon start", () => {
  it("prints PID and version", async () => {
    const ctx = fake({ start: { kind: "started", pid: 77, version: VERSION } });
    expect(await main(["daemon", "start"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["dipo daemon started (pid 77, version 0.0.0-dev)"]);
    expect(ctx.calls.start).toEqual([{}]);
  });

  it("passes --log-level and rejects other options", async () => {
    const ctx = fake({ start: { kind: "started", pid: 77, version: VERSION } });
    expect(await main(["daemon", "start", "--log-level", "debug"], ctx.deps)).toBe(0);
    expect(ctx.calls.start).toEqual([{ logLevel: "debug" }]);
    const bad = fake({});
    expect(await main(["daemon", "start", "--log-level", "loud"], bad.deps)).toBe(2);
  });

  it("says when a daemon already runs", async () => {
    const ctx = fake({ start: { kind: "already running", pid: 77, version: VERSION } });
    expect(await main(["daemon", "start"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["dipo daemon is already running (pid 77, version 0.0.0-dev)"]);
  });

  it("shows config.yaml errors instead of starting", async () => {
    const ctx = fake({
      start: {
        kind: "config",
        errors: [
          {
            file: "/state/config.yaml",
            path: "daemon.autostart",
            expected: "boolean",
            message: "/state/config.yaml: daemon.autostart: expected boolean",
          },
        ],
      },
    });
    expect(await main(["daemon", "start"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toBe("dipo: /state/config.yaml: daemon.autostart: expected boolean");
  });

  it("names the log when the daemon exits during its start", async () => {
    const ctx = fake({ start: { kind: "exited", pid: 999, logs: "/state/logs" } });
    expect(await main(["daemon", "start"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("/state/logs/daemon.log");
  });
});

describe("dipo daemon stop", () => {
  it("stops, and says so when nothing runs", async () => {
    const ctx = fake({ stop: { kind: "stopped", pid: 77, killed: false } });
    expect(await main(["daemon", "stop"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["dipo daemon stopped (pid 77)"]);
    expect(ctx.calls.stop).toEqual([{ force: false }]);

    const none = fake({ stop: { kind: "not running", cleaned: [] } });
    expect(await main(["daemon", "stop"], none.deps)).toBe(0);
    expect(none.out).toEqual(["dipo daemon is not running"]);
  });

  it("passes --force and reports a kill", async () => {
    const ctx = fake({ stop: { kind: "stopped", pid: 77, killed: true } });
    expect(await main(["daemon", "stop", "--force"], ctx.deps)).toBe(0);
    expect(ctx.calls.stop).toEqual([{ force: true }]);
    expect(ctx.out).toEqual(["dipo daemon stopped (pid 77, killed after 10 s)"]);
  });

  it("points an unresponsive daemon to --force", async () => {
    const ctx = fake({ stop: { kind: "unresponsive", pid: 77 } });
    expect(await main(["daemon", "stop"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("dipo daemon stop --force");
  });
});

describe("dipo daemon restart", () => {
  it("stops the old daemon and starts this binary", async () => {
    const ctx = fake({
      restart: {
        kind: "restarted",
        stopped: 77,
        start: { kind: "started", pid: 78, version: VERSION },
      },
    });
    expect(await main(["daemon", "restart"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      "dipo daemon stopped (pid 77)",
      "dipo daemon started (pid 78, version 0.0.0-dev)",
    ]);
  });

  it("refuses before stopping when config.yaml is invalid", async () => {
    const ctx = fake({
      restart: {
        kind: "config",
        errors: [{ file: "/c", path: "version", expected: "1", message: "/c: version: newer" }],
      },
    });
    expect(await main(["daemon", "restart"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual([
      "dipo: /c: version: newer",
      "dipo: nothing was restarted; fix the file and run `dipo daemon restart`.",
    ]);
  });
});

const LAUNCHD: AutostartReport = {
  installed: true,
  file: "/Users/m/Library/LaunchAgents/dipo.daemon.plist",
  program: "/usr/local/bin/dipo",
  programMissing: false,
};

describe("keep-awake and autostart in dipo daemon status (DIPO-63)", () => {
  it("prints keep-awake held with its reason, or not held: <reason>", async () => {
    const held = fake({
      inspect: {
        kind: "running",
        record: RECORD,
        status: { ...STATUS, keepAwake: { held: true, reason: "1 run active" } },
      },
    });
    await main(["daemon", "status"], held.deps);
    expect(held.out).toContain("  keep-awake: held (1 run active)");
    const refused = fake({
      inspect: {
        kind: "running",
        record: RECORD,
        status: { ...STATUS, keepAwake: { held: false, reason: "caffeinate not found" } },
      },
    });
    await main(["daemon", "status"], refused.deps);
    expect(refused.out).toContain("  keep-awake: not held: caffeinate not found");
  });

  it("shows whether autostart is installed and warns about a moved binary", async () => {
    const ctx = fake({
      inspect: { kind: "running", record: RECORD, status: STATUS },
      autostart: { ...LAUNCHD, programMissing: true },
    });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out.at(-1)).toBe(
      "  autostart:  launchd (/Users/m/Library/LaunchAgents/dipo.daemon.plist)",
    );
    expect(ctx.err.join("\n")).toContain("/usr/local/bin/dipo, which no longer exists");
  });

  it("says when autostart is not installed", async () => {
    const ctx = fake({
      inspect: { kind: "not running", cleaned: [] },
      autostart: { ...LAUNCHD, installed: false, program: null },
    });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(3);
    expect(ctx.out).toContain("  autostart:  not installed (`dipo daemon install`)");
    expect(ctx.err).toEqual([]);
  });

  it("says why a stopped daemon refuses to start, from config.yaml", async () => {
    const ctx = fake({
      inspect: { kind: "not running", cleaned: [] },
      configErrors: [{ path: "/s/config.yaml", message: "/s/config.yaml: daemon.x: unknown key" }],
    });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(3);
    expect(ctx.err).toEqual([
      "dipo: the daemon refuses to start: /s/config.yaml: daemon.x: unknown key",
    ]);
  });
});

describe("dipo daemon install and uninstall (DIPO-63)", () => {
  it("prints the file, the supervisor commands and the started daemon", async () => {
    const ctx = fake({
      install: {
        kind: "installed",
        file: LAUNCHD.file,
        commands: [`launchctl bootstrap gui/501 ${LAUNCHD.file}`],
        stopped: 77,
        start: { kind: "started", pid: 4242, version: VERSION },
      },
    });
    expect(await main(["daemon", "install"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      "dipo daemon stopped (pid 77)",
      `installed ${LAUNCHD.file}`,
      `  ran: launchctl bootstrap gui/501 ${LAUNCHD.file}`,
      "launchd starts the daemon at login and restarts it after a crash.",
      "dipo daemon started (pid 4242, version 0.0.0-dev)",
    ]);
    expect(ctx.err).toEqual([]);
  });

  it("says autostart needs launchd where there is none", async () => {
    const ctx = fake({ install: { kind: "unsupported" } });
    expect(await main(["daemon", "install"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: autostart needs launchd (macOS)."]);
  });

  it("refuses an invalid config.yaml and a failed supervisor command", async () => {
    const config = fake({
      install: {
        kind: "config",
        errors: [{ file: "/c", path: "x", expected: "y", message: "/c: bad" }],
      },
    });
    expect(await main(["daemon", "install"], config.deps)).toBe(1);
    expect(config.err).toContain("dipo: /c: bad");
    const failed = fake({
      install: { kind: "failed", file: "/f", message: "`launchctl bootstrap` failed (exit 5)" },
    });
    expect(await main(["daemon", "install"], failed.deps)).toBe(1);
    expect(failed.err[0]).toContain("could not install /f");
    expect(await main(["daemon", "install", "--now"], failed.deps)).toBe(2);
  });

  it("uninstalls, and says so when nothing is installed", async () => {
    const done = fake({
      uninstall: {
        kind: "uninstalled",
        file: LAUNCHD.file,
        commands: ["launchctl bootout gui/501/dipo.daemon"],
        stopped: 4242,
      },
    });
    expect(await main(["daemon", "uninstall"], done.deps)).toBe(0);
    expect(done.out).toContain(`removed ${LAUNCHD.file}`);
    const none = fake({ uninstall: { kind: "not installed", file: LAUNCHD.file } });
    expect(await main(["daemon", "uninstall"], none.deps)).toBe(0);
    expect(none.out[0]).toContain("autostart is not installed");
  });
});
