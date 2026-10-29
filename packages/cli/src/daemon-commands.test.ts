import { describe, expect, it } from "bun:test";

import { ClientError } from "@dipsaus-orchestrator/client";
import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { type DaemonControl, REPLY_TIMEOUT_MS, type DaemonSession } from "./daemon-commands";
import { fakeWorkspace } from "../test/support/fake-workspace";
import { main, type CliDeps } from "./index";

type Sent = { name: string; args: unknown };
type Handler = (sent: Sent) => Promise<unknown>;

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

function fake(connect: () => Promise<Handler>, daemon: DaemonControl = NO_LIFECYCLE) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  let closed = 0;
  const clock = new ManualClock();
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const handler = await connect();
      const session: DaemonSession = {
        command: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return handler(message);
        }) as DaemonSession["command"],
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        read: (async () => {
          throw new Error("read must not be called");
        }) as DaemonSession["read"],
        close: () => void (closed += 1),
      };
      return session;
    },
    daemon,
    clock,
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace(),
  };
  return { deps, out, err, sent, clock, closed: () => closed };
}

const answering = (handler: Handler) => () => Promise.resolve(handler);

describe("dipo daemon log-level and resume-scheduling", () => {
  it("sends daemon.setLogLevel and prints the new level", async () => {
    const ctx = fake(answering(async ({ args }) => ({ ok: true, result: args, changed: true })));
    expect(await main(["daemon", "log-level", "debug"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "daemon.setLogLevel", args: { level: "debug" } }]);
    expect(ctx.out).toEqual(["daemon log level: debug (until the daemon restarts)"]);
    expect(ctx.closed()).toBe(1);
  });

  it("says when the level did not change", async () => {
    const ctx = fake(answering(async ({ args }) => ({ ok: true, result: args, changed: false })));
    expect(await main(["daemon", "log-level", "info"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["daemon log level: info (unchanged)"]);
  });

  it("sends daemon.resumeScheduling and prints the state", async () => {
    const ctx = fake(
      answering(async () => ({ ok: true, result: { state: "running" }, changed: true })),
    );
    expect(await main(["daemon", "resume-scheduling"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "daemon.resumeScheduling", args: {} }]);
    expect(ctx.out).toEqual(["scheduling resumed and starts unpaused; daemon state: running"]);
  });

  it("prints an engine error's code and message and exits 1", async () => {
    const ctx = fake(
      answering(async () => ({
        ok: false,
        error: {
          code: "daemon.notSafe",
          message: "Scheduling is not off: the daemon is running, not safe.",
          retryable: false,
        },
      })),
    );
    expect(await main(["daemon", "resume-scheduling"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual([
      "dipo: daemon.notSafe: Scheduling is not off: the daemon is running, not safe.",
    ]);
    expect(ctx.closed()).toBe(1);
  });

  it("names dipo daemon start and exits non-zero when no daemon is running", async () => {
    for (const argv of [
      ["daemon", "log-level", "debug"],
      ["daemon", "resume-scheduling"],
    ]) {
      const ctx = fake(() =>
        Promise.reject(new DaemonNotRunningError("/state", "no runtime.json in /state")),
      );
      expect(await main(argv, ctx.deps)).toBe(1);
      expect(ctx.err).toEqual([
        "dipo: no daemon is running (no runtime.json in /state). Start it with `dipo daemon start`.",
      ]);
      expect(ctx.out).toEqual([]);
    }
  });

  it("prints a client error's code, such as contract.unsupported", async () => {
    const ctx = fake(() =>
      Promise.reject(new ClientError("contract.unsupported", "The daemon speaks contract 2.0.")),
    );
    expect(await main(["daemon", "log-level", "debug"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual([
      "dipo: contract.unsupported: The daemon speaks contract 2.0.",
      "dipo: run `dipo daemon restart`",
    ]);
  });

  it("gives up when no reply arrives within the deadline", async () => {
    const ctx = fake(answering(() => new Promise(() => {})));
    const running = main(["daemon", "log-level", "debug"], ctx.deps);
    await Bun.sleep(0);
    ctx.clock.advance(REPLY_TIMEOUT_MS);
    expect(await running).toBe(1);
    expect(ctx.err).toEqual(["dipo: the daemon did not answer within 10 s."]);
    expect(ctx.closed()).toBe(1);
  });

  it("rejects a missing or unknown level and extra arguments without connecting", async () => {
    for (const argv of [
      ["daemon", "log-level"],
      ["daemon", "log-level", "loud"],
      ["daemon", "log-level", "debug", "extra"],
      ["daemon", "resume-scheduling", "now"],
    ]) {
      const ctx = fake(() => Promise.reject(new Error("must not connect")));
      expect(await main(argv, ctx.deps)).toBe(2);
      expect(ctx.err[0]).toMatch(/^dipo: daemon (log-level|resume-scheduling)/);
    }
  });
});

function statusCtx(result: Record<string, unknown>) {
  const ctx = fake(() => Promise.reject(new Error("must not connect")), {
    ...NO_LIFECYCLE,
    inspect: async () => ({ kind: "running", status: result }) as never,
  });
  return ctx;
}

describe("dipo daemon status build commit (DIPO-198)", () => {
  const status = {
    state: "running",
    pid: 4242,
    version: "0.1.0-dev",
    uptimeMs: 5000,
    socket: "/run/dipo/dipo.sock",
    loadedOffices: ["off_01J9ZK5Q8W3V4X6Y7Z00000001"],
    activeRuns: 0,
    keepAwake: { held: false },
    upgradePending: false,
    tools: {},
    buildCommit: "1a2b3c4d5e6f-dirty",
    engineBehind: [
      { office: "off_01J9ZK5Q8W3V4X6Y7Z00000001", name: "dipsaus-orchestrator", commits: 1 },
      { office: "off_01J9ZK5Q8W3V4X6Y7Z00000002", name: "current", commits: 0 },
    ],
  };

  it("prints the commit and a rebuild line for an office behind", async () => {
    const ctx = statusCtx(status);
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out).toContain("  commit:     1a2b3c4d5e6f-dirty");
    expect(ctx.out).toContain(
      "  dipsaus-orchestrator: the base has 1 engine commit after this build; rebuild dipo and run `dipo daemon restart`",
    );
    expect(ctx.out.join("\n")).not.toContain("current:");
  });

  it("prints the active runs summed over the loaded offices (DIPO-125)", async () => {
    const ctx = statusCtx({
      ...status,
      loadedOffices: ["off_01J9ZK5Q8W3V4X6Y7Z00000001", "off_01J9ZK5Q8W3V4X6Y7Z00000002"],
      activeRuns: 3,
    });
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out.join("\n")).toContain("  offices:    2 loaded, 3 active runs");
  });

  it("prints neither line when run from source", async () => {
    const { buildCommit: _c, engineBehind: _e, ...source } = status;
    const ctx = statusCtx(source);
    expect(await main(["daemon", "status"], ctx.deps)).toBe(0);
    expect(ctx.out.join("\n")).not.toContain("commit");
  });

  it("carries both fields in --json", async () => {
    const ctx = statusCtx(status);
    expect(await main(["daemon", "status", "--json"], ctx.deps)).toBe(0);
    const parsed = JSON.parse(ctx.out[0] ?? "{}") as { daemon: typeof status };
    expect(parsed.daemon.buildCommit).toBe("1a2b3c4d5e6f-dirty");
    expect(parsed.daemon.engineBehind[0]?.commits).toBe(1);
  });
});
