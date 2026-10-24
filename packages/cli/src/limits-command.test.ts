// `dipo limits` and `dipo limits allow` (DIPO-338): reads `office.limits` and prints the plan-limit
// holds and the allowance; `allow --until --note` and `allow --clear` send `limits.allow` without
// asking.

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspace, type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { HELP, main, type CliDeps } from "./index";
import { NO_HOLDS } from "./limits-command";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const IN_OFFICE = {
  repository: {
    mainWorktree: "/work/app",
    commonDir: "/work/app/.git",
    office: OFFICE,
    backlog: true,
  },
};

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

type Sent = { name: string; args: unknown; office: unknown };

function fake(reply: (sent: Sent) => unknown, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const ws: FakeWorkspace = fakeWorkspace({ cwd: "/work/app", ...IN_OFFICE, ...workspace });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () =>
      ({
        command: (async (definition: { name: string }, args: unknown, options: unknown) => {
          const message = {
            name: definition.name,
            args,
            office: (options as { office?: unknown } | undefined)?.office,
          };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["command"],
        read: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args, office: undefined };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["read"],
        close: () => undefined,
      }) as unknown as DaemonSession,
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent, ws };
}

const UNTIL = "2026-10-27T09:00:00.000Z";
const ALLOWANCE = { by: "cli", at: "2026-10-24T10:00:00.000Z", until: UNTIL, note: "finish M1b" };

describe("dipo limits", () => {
  it("reads office.limits and prints each hold and the allowance", async () => {
    const ctx = fake(() => ({
      ok: true,
      result: {
        holds: [
          { scope: "weekly", until: UNTIL, utilization: 0.8, rejected: false, allowed: true },
          { scope: "session", until: "2026-10-24T15:00:00.000Z", rejected: true, allowed: false },
        ],
        allowance: ALLOWANCE,
      },
    }));
    expect(await main(["limits"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "office.limits", args: { office: OFFICE }, office: undefined },
    ]);
    expect(ctx.out).toEqual([
      `weekly warning · 80% used · until ${UNTIL} · allowed: new sessions go on`,
      "session rejected · until 2026-10-24T15:00:00.000Z · holds new sessions",
      `allowance until ${UNTIL} · set 2026-10-24T10:00:00.000Z by cli · "finish M1b"`,
    ]);
  });

  it("says when nothing holds", async () => {
    const ctx = fake(() => ({ ok: true, result: { holds: [] } }));
    expect(await main(["limits"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([NO_HOLDS]);
  });
});

describe("dipo limits allow", () => {
  it("sends limits.allow with the time as ISO and the note, without asking", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: { allowance: ALLOWANCE } }));
    expect(
      await main(
        ["limits", "allow", "--until", "2026-10-27T11:00+02:00", "--note", "finish M1b"],
        ctx.deps,
      ),
    ).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "limits.allow", args: { until: UNTIL, note: "finish M1b" }, office: OFFICE },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([
      `new sessions go on past the plan's warnings until ${UNTIL}; a rejected limit and the five-hour window still hold`,
    ]);
  });

  it("--clear ends the allowance", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: {} }));
    expect(await main(["limits", "allow", "--clear"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "limits.allow", args: { clear: true }, office: OFFICE }]);
    expect(ctx.out).toEqual(["allowance ended: the plan's warnings hold new sessions again"]);
  });

  it("refuses a missing note, a bad time and --clear with --until, sending nothing", async () => {
    for (const args of [
      ["--until", UNTIL],
      ["--until", "next week", "--note", "x"],
      ["--clear", "--until", UNTIL],
      [],
    ]) {
      const ctx = fake(() => ({ ok: true, result: {} }));
      expect(await main(["limits", "allow", ...args], ctx.deps)).toBe(2);
      expect(ctx.sent).toEqual([]);
    }
  });

  it("prints the engine's limits.noWarning", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "limits.noWarning",
        message: "No plan-limit warning is in force.",
        retryable: false,
      },
    }));
    expect(await main(["limits", "allow", "--until", UNTIL, "--note", "x"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("limits.noWarning");
  });

  it("is in the help", () => {
    expect(HELP).toContain("dipo limits allow --until <time> --note <why>");
  });
});
