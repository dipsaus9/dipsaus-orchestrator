import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

import { ManualClock, isolatedDaemonEnv, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";
import { buildRegistry, type Logger } from "@dipsaus-orchestrator/engine";
import type { OfficeId } from "@dipsaus-orchestrator/contract";

import * as daemon from "./index";
import { controlFeature, type ControlDeps } from "./control";
import { noOrphansActive } from "./io";
import { DaemonLifecycle } from "./lifecycle";

const { runDaemon } = daemon;

function capture(overrides: { env?: Record<string, string>; execArgv?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    writeLine: (line: string) => out.push(line),
    writeError: (line: string) => err.push(line),
    env: overrides.env ?? {},
    execArgv: overrides.execArgv ?? [],
    // No listener for uncaught errors on the test runner's own process (DIPO-117).
    uncaughtErrors: new EventEmitter(),
  };
  return { io, out, err };
}

describe("runDaemon", () => {
  it("is the package's only export (0004)", () => {
    expect(Object.keys(daemon)).toEqual(["runDaemon"]);
  });

  it("rejects an unknown form with a usage message and exit code 2", async () => {
    const { io, out, err } = capture();
    expect(await runDaemon(["no-such-form"], io)).toBe(2);
    expect(out).toEqual([]);
    const message = err.join("\n");
    expect(message).toContain("no-such-form");
    expect(message).toContain("dipo daemon --foreground");
    expect(message).toContain("dipo daemon worker-host <run-id>");
    expect(message).toContain("dipo daemon wait-pid <pid>");
    expect(message).not.toContain("self-check");
  });

  it("rejects an empty form", async () => {
    const { io, err } = capture();
    expect(await runDaemon([], io)).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  });

  it("checks the worker-host and wait-pid arguments", async () => {
    for (const argv of [
      ["worker-host"],
      ["worker-host", "nope"],
      ["wait-pid", "-1"],
      ["wait-pid"],
    ]) {
      const { io, err } = capture();
      expect(await runDaemon(argv, io)).toBe(2);
      expect(err.join("\n")).toContain("usage:");
    }
  });

  it("dispatches worker-host, which needs DIPO_RUN_DIR", async () => {
    const host = capture();
    expect(await runDaemon(["worker-host", "run_01JZ0000000000000000000000"], host.io)).toBe(2);
    expect(host.err.join("\n")).toContain("DIPO_RUN_DIR");
    const relative = capture({ env: { DIPO_RUN_DIR: "runs/x" } });
    expect(await runDaemon(["worker-host", "run_01JZ0000000000000000000000"], relative.io)).toBe(2);
  });

  it("refuses a worker host with --no-orphans in BUN_OPTIONS", async () => {
    const { io, err } = capture({ env: { BUN_OPTIONS: "--no-orphans", DIPO_RUN_DIR: "/x" } });
    expect(await runDaemon(["worker-host", "run_01JZ0000000000000000000000"], io)).toBe(1);
    expect(err.join("\n")).toContain("--no-orphans");
  });

  it("dispatches wait-pid, which exits 0 at once for a process already gone (DIPO-63)", async () => {
    // A process that has exited stands in for the daemon. The wait on a live process, which polls
    // once a second, is in index.ci.test.ts (DIPO-79).
    const gone = Bun.spawn({ cmd: ["true"], stdin: "ignore", stdout: "ignore" });
    await gone.exited;
    const wait = capture();
    expect(await runDaemon(["wait-pid", String(gone.pid)], wait.io)).toBe(0);
    expect(wait.err).toEqual([]);
  });

  // The --foreground cases get state, runtime and temp directories under a temp directory
  // (DIPO-109), although each is refused before it would use them.
  it("refuses --foreground when --no-orphans is in the Bun flags", () =>
    withDaemonTempDir(async (dir) => {
      const { io, err } = capture({ env: isolatedDaemonEnv(dir), execArgv: ["--no-orphans"] });
      expect(await runDaemon(["--foreground"], io)).toBe(1);
      expect(err.join("\n")).toContain("--no-orphans");
    }));

  it("refuses --foreground when --no-orphans is in BUN_OPTIONS", () =>
    withDaemonTempDir(async (dir) => {
      const { io, err } = capture({
        env: { ...isolatedDaemonEnv(dir), BUN_OPTIONS: "--smol --no-orphans" },
      });
      expect(await runDaemon(["--foreground"], io)).toBe(1);
      expect(err.join("\n")).toContain("BUN_OPTIONS");
    }));

  it("rejects an unknown log level before touching any directory", () =>
    withDaemonTempDir(async (dir) => {
      const env = isolatedDaemonEnv(dir);
      const { io, err } = capture({ env });
      expect(await runDaemon(["--foreground", "--log-level", "loud"], io)).toBe(2);
      expect(err.join("\n")).toContain("unknown log level");
      expect(existsSync(env.DIPO_HOME)).toBe(false);
      expect(existsSync(env.DIPO_RUNTIME_DIR)).toBe(false);
    }));
});

describe("noOrphansActive", () => {
  it("finds the flag only as a whole word", () => {
    expect(noOrphansActive({ execArgv: [], env: {} })).toBe(false);
    expect(noOrphansActive({ execArgv: [], env: { BUN_OPTIONS: "--no-orphans-like" } })).toBe(
      false,
    );
    expect(noOrphansActive({ execArgv: ["--no-orphans=true"], env: {} })).toBe(true);
    expect(noOrphansActive({ execArgv: [], env: { BUN_OPTIONS: " --no-orphans" } })).toBe(true);
    expect(noOrphansActive({ execArgv: [], env: { BUN_FEATURE_FLAG_NO_ORPHANS: "1" } })).toBe(true);
    expect(noOrphansActive({ execArgv: [], env: { BUN_FEATURE_FLAG_NO_ORPHANS: "0" } })).toBe(
      false,
    );
  });
});

describe("daemon.status build commit (DIPO-198)", () => {
  const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;

  async function status(extra: Partial<ControlDeps>) {
    const clock = new ManualClock();
    const registry = buildRegistry([
      controlFeature({
        lifecycle: new DaemonLifecycle(),
        logger: {} as Logger,
        clock,
        startedAt: clock.now(),
        pid: 1,
        version: "0.0.0-test",
        socket: "/s",
        tools: {},
        upgradePending: () => false,
        loadedOffices: () => [OFFICE],
        requestStop: () => {},
        ...extra,
      }),
    ]);
    const read = registry.read("daemon.status");
    if (read === undefined) throw new Error("daemon.status is not registered");
    return (await (read.handle as (ctx: unknown, args: unknown) => Promise<unknown>)({}, {})) as {
      buildCommit?: string;
      engineBehind?: unknown;
    };
  }

  it("carries the build commit, dirty suffix included, and the offices behind", async () => {
    const result = await status({
      buildCommit: "1a2b3c4d5e6f-dirty",
      engineBehind: async () => [{ office: OFFICE, name: "repo", commits: 1 }],
    });
    expect(result.buildCommit).toBe("1a2b3c4d5e6f-dirty");
    expect(result.engineBehind).toEqual([{ office: OFFICE, name: "repo", commits: 1 }]);
  });

  it("has neither field when run from source", async () => {
    const result = await status({});
    expect("buildCommit" in result).toBe(false);
    expect("engineBehind" in result).toBe(false);
  });
});
