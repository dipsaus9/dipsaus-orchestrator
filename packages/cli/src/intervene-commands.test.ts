// `dipo steer <ID> <text>` (DIPO-163): it asks for no confirmation; the steer text is the words
// after the story id. `dipo pause` is gone (0020): `dipo park` replaced it.

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import {
  type FakeWorkspace,
  type FakeWorkspaceOptions,
  fakeWorkspace,
} from "../test/support/fake-workspace";
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

const RUN_ID = RUN;

describe("dipo steer", () => {
  it("sends work.steer with the words after the id joined, and says when the worker reads it", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { run: RUN_ID, delivered: "next-turn" },
    }));
    expect(await main(["steer", "dipo-7", "use", "the", "helper"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "work.steer", args: { story: "DIPO-7", text: "use the helper" }, office: OFFICE },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out[0]).toContain("with its next turn");
  });

  it("says the steer waits for the resume when the story is paused or parked", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { run: RUN_ID, delivered: "on-resume" },
    }));
    expect(await main(["steer", "DIPO-7", "try again"], ctx.deps)).toBe(0);
    expect(ctx.out[0]).toContain("first message on resume");
  });

  it("needs a story id and a text", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["steer"], ctx.deps)).toBe(2);
    expect(await main(["steer", "DIPO-7"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });

  it("prints the engine's refusal and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "story.notSteerable",
        message: "its live session is its reviewer",
        retryable: false,
      },
    }));
    expect(await main(["steer", "DIPO-7", "hi"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("its live session is its reviewer");
  });
});

describe("dipo pause", () => {
  it("is gone: dipo park replaced it (0020)", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["pause", "DIPO-7"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});
