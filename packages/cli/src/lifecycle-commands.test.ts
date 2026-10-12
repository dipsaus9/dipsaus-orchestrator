// `dipo daemon start|stop|restart|status` (DIPO-70, 0006 decisions 5 and 14) over a fake
// lifecycle: the printed reports, `--json`, the exit codes 0, 1 and 3, and the restart hint.

import { describe, expect, it } from "bun:test";

import type {
  DaemonObservation,
  DaemonStatusResult,
  RestartResult,
  StartResult,
  StopResult,
} from "@dipsaus-orchestrator/client/node";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl } from "./daemon-commands";
import { fakeWorkspace } from "./fake-workspace";
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
      inspect: { kind: "not running", cleaned: ["/state/dipo.pid", "/state/runtime.json"] },
    });
    expect(await main(["daemon", "status"], stale.deps)).toBe(3);
    expect(stale.out).toEqual([
      "stale",
      "  removed leftovers of a daemon that is gone: /state/dipo.pid, /state/runtime.json",
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
    ];
    for (const [inspect, code, json] of cases) {
      const ctx = fake({ inspect });
      expect(await main(["daemon", "status", "--json"], ctx.deps)).toBe(code);
      expect(JSON.parse(ctx.out.join("\n"))).toEqual(json);
    }
  });

  it("reports a daemon of another contract major as running with the restart hint", async () => {
    const ctx = fake({
      inspect: {
        kind: "foreign",
        record: RECORD,
        details: { contract: { major: 2, minor: 0 }, version: "2.0.0" },
      },
    });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out[0]).toBe("running");
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
