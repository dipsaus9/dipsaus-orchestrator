// `dipo next confirm|decline <ID>` (DIPO-440): sends `nextUp.confirm` or `nextUp.decline` for the
// story a NEXT UP desk item offers, without asking; prints the started story or why it was skipped,
// and after a decline the stories offered now.

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import {
  type FakeWorkspace,
  type FakeWorkspaceOptions,
  fakeWorkspace,
} from "../test/support/fake-workspace";
import { HELP, main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D";
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D";
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

describe("dipo next confirm", () => {
  it("sends nextUp.confirm for the story, without asking, and prints the started run", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { started: [{ story: "DIPO-29", key: KEY, run: RUN }], skipped: [] },
    }));
    expect(await main(["next", "confirm", "dipo-29"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "nextUp.confirm", args: { story: "DIPO-29" }, office: OFFICE },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([`started DIPO-29 (run ${RUN})`]);
  });

  it("prints why the story was skipped and exits 1", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: false,
      result: {
        started: [],
        skipped: [{ story: "DIPO-29", key: KEY, reason: "dependency" }],
      },
    }));
    expect(await main(["next", "confirm", "DIPO-29"], ctx.deps)).toBe(1);
    expect(ctx.out).toEqual(["skipped DIPO-29: a dependency is not Done"]);
  });

  it("prints the engine's refusal of a story not offered and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "nextUp.notOffered",
        message: "DIPO-29 is not offered as next up now",
        retryable: false,
      },
    }));
    expect(await main(["next", "confirm", "DIPO-29"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("DIPO-29 is not offered as next up now");
  });
});

describe("dipo next decline", () => {
  it("sends nextUp.decline and prints the stories offered now", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { story: "DIPO-29", key: KEY, offered: ["DIPO-30"] },
    }));
    expect(await main(["next", "decline", "DIPO-29", "--office", OFFICE], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "nextUp.decline", args: { story: "DIPO-29" }, office: OFFICE },
    ]);
    expect(ctx.out).toEqual(["declined DIPO-29; next up now: DIPO-30"]);
  });

  it("says when no other story is next up", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { story: "DIPO-29", key: KEY, offered: [] },
    }));
    expect(await main(["next", "decline", "DIPO-29"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["declined DIPO-29; no other story is next up now"]);
  });
});

describe("dipo next usage", () => {
  it("is in the help, and needs confirm or decline and one story id", async () => {
    expect(HELP).toContain("dipo next confirm|decline <id> [--office <id>]");
    const ctx = fake(() => ({}));
    expect(await main(["next"], ctx.deps)).toBe(2);
    expect(await main(["next", "start", "DIPO-29"], ctx.deps)).toBe(2);
    expect(await main(["next", "confirm"], ctx.deps)).toBe(2);
    expect(await main(["next", "confirm", "not an id"], ctx.deps)).toBe(2);
    expect(await main(["next", "confirm", "DIPO-29", "DIPO-30"], ctx.deps)).toBe(2);
    expect(await main(["next", "confirm", "DIPO-29", "--yes"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});
