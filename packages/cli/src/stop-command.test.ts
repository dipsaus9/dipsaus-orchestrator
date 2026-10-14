// `dipo stop <ID>` (DIPO-50): asks first because `work.stop` is `confirm: true` in the contract, as
// `commands.describe` reports it; `--yes` answers for a script; without a terminal it refuses.

import { describe, expect, it } from "bun:test";

import { type OfficeId, workStop } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspace, type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
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

const stopped = () => ({ ok: true, changed: true, result: { run: RUN } });

describe("dipo stop", () => {
  it("is a confirm command in the contract", () => {
    expect(workStop.confirm).toBe(true);
  });

  it("asks first, then sends work.stop with the note", async () => {
    const ctx = fake(stopped, { interactive: true, answers: ["y"] });
    expect(await main(["stop", "dipo-7", "--note", "Wrong approach"], ctx.deps)).toBe(0);
    expect(ctx.ws.questions).toHaveLength(1);
    expect(ctx.ws.questions[0]).toContain("Stop the worker of DIPO-7?");
    expect(ctx.sent).toEqual([
      { name: "work.stop", args: { story: "DIPO-7", note: "Wrong approach" }, office: OFFICE },
    ]);
    expect(ctx.out).toEqual([
      `stopped DIPO-7 (run ${RUN}); it is parked as stopped, branch and worktree kept`,
    ]);
  });

  it("sends nothing when the answer is no", async () => {
    const ctx = fake(stopped, { interactive: true, answers: ["n"] });
    expect(await main(["stop", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([]);
    expect(ctx.out).toEqual(["nothing stopped"]);
  });

  it("refuses without a terminal unless --yes is given", async () => {
    const refused = fake(stopped);
    expect(await main(["stop", "DIPO-7"], refused.deps)).toBe(1);
    expect(refused.sent).toEqual([]);
    expect(refused.err[0]).toContain("needs confirmation");

    const yes = fake(stopped);
    expect(await main(["stop", "DIPO-7", "--yes"], yes.deps)).toBe(0);
    expect(yes.ws.questions).toEqual([]);
    expect(yes.sent.map((s) => s.name)).toEqual(["work.stop"]);
  });

  it("prints story.notRunning from the engine and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "story.notRunning",
        message: "DIPO-7 has no running worker to stop.",
        retryable: false,
      },
    }));
    expect(await main(["stop", "DIPO-7", "--yes"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: story.notRunning: DIPO-7 has no running worker to stop."]);
  });

  it("needs exactly one story id", async () => {
    expect(await main(["stop"], fake(stopped).deps)).toBe(2);
    expect(await main(["stop", "DIPO-7", "DIPO-8"], fake(stopped).deps)).toBe(2);
  });
});
