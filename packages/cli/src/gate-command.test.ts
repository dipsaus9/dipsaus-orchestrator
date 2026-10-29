// `dipo gate <id>` (DIPO-71): sends the read `story.gate` for the office of `--office` or of the
// current directory, prints `ready <ID> passed` or each failure line, and exits 1 on a failure.
// Warnings (R29, DIPO-251) are printed after the verdict and do not change the exit code.

import { describe, expect, it } from "bun:test";

import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  type DaemonControl,
  type DaemonSession,
  REPLY_TIMEOUT_MS,
  START_HINT,
} from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "../test/support/fake-workspace";
import { GATE_TIMEOUT_MS } from "./gate-command";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const OTHER = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F";
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };

type Sent = { name: string; args: unknown };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

function fake(reply: (sent: Sent) => unknown, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const clock = new ManualClock();
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const session: DaemonSession = {
        command: () => Promise.reject(new Error("command must not be called")),
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        read: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["read"],
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock,
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace({ cwd: "/work/app/src", ...workspace }),
  };
  return { deps, out, err, sent, clock };
}

const IN_OFFICE = { repository: { ...REPO, office: OFFICE, backlog: true } };

const result = (passed: boolean, failures: { rule: string; message: string }[] = []) => ({
  ok: true,
  result: { story: "DIPO-7", key: KEY, passed, failures },
});

describe("dipo gate without a daemon (DIPO-187)", () => {
  it("prints the not-running line with the start hint, exits 1 and asks not to start the daemon", async () => {
    const modes: string[] = [];
    const ctx = fake(() => result(true), IN_OFFICE);
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["gate", "DIPO-7"], deps)).toBe(1);
    expect(modes).toEqual(["running"]);
    expect(ctx.err).toEqual([
      `dipo: no daemon is running (nothing answers on /state/dipo.sock). ${START_HINT}`,
    ]);
    expect(ctx.out).toEqual([]);
  });

  it("does not start the daemon after a yes to opening an unregistered project", async () => {
    const modes: string[] = [];
    const ctx = fake(() => result(true), {
      repository: { ...REPO, backlog: true },
      interactive: true,
      answers: ["y"],
    });
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["gate", "DIPO-7"], deps)).toBe(1);
    expect(modes).toEqual(["running"]);
    expect(ctx.err).toEqual([
      "dipo: not an office, run `dipo office open`",
      `dipo: no daemon is running (nothing answers on /state/dipo.sock). ${START_HINT}`,
    ]);
    expect(ctx.out).toEqual([]);
  });
});

describe("dipo gate", () => {
  it("prints `ready <ID> passed` and exits 0 when every rule passes", async () => {
    const ctx = fake(() => result(true), IN_OFFICE);
    expect(await main(["gate", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "story.gate", args: { office: OFFICE, story: "DIPO-7" } }]);
    expect(ctx.out).toEqual(["ready DIPO-7 passed"]);
    expect(ctx.err).toEqual([]);
  });

  it("prints each failure on its own line and exits 1", async () => {
    const failures = [
      { rule: "R07", message: "ready DIPO-7 failed R07: milestone is missing or does not exist" },
      {
        rule: "R11",
        message: "ready DIPO-7 failed R11: no declared scope; add at least one path with --ref",
      },
    ];
    const ctx = fake(() => result(false, failures), IN_OFFICE);
    expect(await main(["gate", "dipo-7"], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([{ name: "story.gate", args: { office: OFFICE, story: "DIPO-7" } }]);
    expect(ctx.out).toEqual(failures.map((failure) => failure.message));
  });

  it("uses --office before or after the id, and passes a story key as is", async () => {
    const ctx = fake(() => result(true));
    expect(await main(["gate", "--office", OTHER, KEY], ctx.deps)).toBe(0);
    expect(await main(["gate", "DIPO-7", "--office", OTHER], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "story.gate", args: { office: OTHER, story: KEY } },
      { name: "story.gate", args: { office: OTHER, story: "DIPO-7" } },
    ]);
  });

  it("names the open dependencies after the passed line and exits 0", async () => {
    const waitingOn = [
      { id: "DIPO-3", status: "Ready" },
      { id: "DIPO-4", status: "Refined" },
    ];
    const ctx = fake(
      () => ({ ok: true, result: { ...result(true).result, waitingOn } }),
      IN_OFFICE,
    );
    expect(await main(["gate", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["ready DIPO-7 passed", "waits on DIPO-3 (Ready), DIPO-4 (Refined)"]);
    expect(ctx.err).toEqual([]);
  });

  it("prints only the passed line when every dependency is Done", async () => {
    const ctx = fake(() => result(true), IN_OFFICE);
    expect(await main(["gate", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["ready DIPO-7 passed"]);
  });

  it("prints the failures, then the open dependencies, and exits 1", async () => {
    const failure = "ready DIPO-7 failed R07: milestone is missing or does not exist";
    const ctx = fake(
      () => ({
        ok: true,
        result: {
          ...result(false, [{ rule: "R07", message: failure }]).result,
          waitingOn: [{ id: "DIPO-3" }],
        },
      }),
      IN_OFFICE,
    );
    expect(await main(["gate", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.out).toEqual([failure, "waits on DIPO-3 (missing)"]);
  });

  it("prints each warning after the verdict and keeps the exit code (R29, DIPO-251)", async () => {
    const warning =
      "ready DIPO-7 warning R29: test plan entry #1 names packages/daemon/x.ts, which no Reference covers; add it to the References or drop it from the plan";
    const warnings = [{ rule: "R29", message: warning }];
    const passing = fake(
      () => ({
        ok: true,
        result: { ...result(true).result, warnings, waitingOn: [{ id: "DIPO-3" }] },
      }),
      IN_OFFICE,
    );
    expect(await main(["gate", "DIPO-7"], passing.deps)).toBe(0);
    expect(passing.out).toEqual(["ready DIPO-7 passed", warning, "waits on DIPO-3 (missing)"]);
    const failure = "ready DIPO-7 failed R07: milestone is missing or does not exist";
    const failing = fake(
      () => ({
        ok: true,
        result: { ...result(false, [{ rule: "R07", message: failure }]).result, warnings },
      }),
      IN_OFFICE,
    );
    expect(await main(["gate", "DIPO-7"], failing.deps)).toBe(1);
    expect(failing.out).toEqual([failure, warning]);
  });

  it("prints an engine error and exits 1", async () => {
    const ctx = fake(
      () => ({
        ok: false,
        error: { code: "story.unknown", message: "No story is DIPO-99.", retryable: false },
      }),
      IN_OFFICE,
    );
    expect(await main(["gate", "DIPO-99"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: story.unknown: No story is DIPO-99."]);
    expect(ctx.out).toEqual([]);
  });

  it("says `not an office` in an unregistered Backlog.md project", async () => {
    const ctx = fake(() => result(true), { repository: { ...REPO, backlog: true } });
    expect(await main(["gate", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([]);
    expect(ctx.err).toEqual(["dipo: not an office, run `dipo office open`"]);
  });

  it("waits for the gate read longer than the default reply deadline, then gives up", async () => {
    const ctx = fake(() => new Promise(() => {}), IN_OFFICE);
    const running = main(["gate", "DIPO-7"], ctx.deps);
    await Bun.sleep(0);
    ctx.clock.advance(REPLY_TIMEOUT_MS);
    await Bun.sleep(0);
    expect(ctx.err).toEqual([]);
    ctx.clock.advance(GATE_TIMEOUT_MS - REPLY_TIMEOUT_MS);
    expect(await running).toBe(1);
    expect(ctx.err).toEqual([
      `dipo: the daemon did not answer within ${GATE_TIMEOUT_MS / 1000} s.`,
    ]);
  });

  it("refuses a missing or malformed id and unknown arguments", async () => {
    for (const args of [["gate"], ["gate", "seven"], ["gate", "DIPO-7", "--yes"]]) {
      const ctx = fake(() => result(true), IN_OFFICE);
      expect(await main(args, ctx.deps)).toBe(2);
      expect(ctx.sent).toEqual([]);
    }
  });
});
