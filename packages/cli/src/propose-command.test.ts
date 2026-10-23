// `dipo propose accept|dismiss <proposal>` (DIPO-166): sends `proposal.accept` or
// `proposal.dismiss` for the proposal id the desk prints, or a prefix of 8 or more of its
// characters, without asking; prints where the accepted proposal is filed.

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspace, type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { HELP, main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const PROPOSAL = "3f".repeat(32);
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

describe("dipo propose accept", () => {
  it("sends proposal.accept for the id, without asking, and prints the draft it filed", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { proposal: PROPOSAL, state: "accepted", draft: "DRAFT-4" },
    }));
    expect(await main(["propose", "accept", PROPOSAL], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "proposal.accept", args: { proposal: PROPOSAL }, office: OFFICE },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([
      "accepted proposal 3f3f3f3f3f3f: filed as Backlog draft DRAFT-4 through the backlog PR",
    ]);
  });

  it("takes a prefix in any case and --office, and says when the draft waits for the lane", async () => {
    const other = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";
    const ctx = fake(() => ({
      ok: true,
      changed: false,
      result: { proposal: PROPOSAL, state: "accepted" },
    }));
    expect(await main(["propose", "accept", "3F3F3F3F", "--office", other], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "proposal.accept", args: { proposal: "3f3f3f3f" }, office: other },
    ]);
    expect(ctx.out).toEqual([
      "proposal 3f3f3f3f3f3f was accepted already: dipo files it as a Backlog draft through the backlog PR",
    ]);
  });

  it("prints the engine's refusal and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "proposal.notOpen", message: "it was dismissed", retryable: false },
    }));
    expect(await main(["propose", "accept", PROPOSAL], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("it was dismissed");
  });
});

describe("dipo propose dismiss", () => {
  it("sends proposal.dismiss and says nothing is filed", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { proposal: PROPOSAL, state: "dismissed" },
    }));
    expect(await main(["propose", "dismiss", PROPOSAL.slice(0, 10)], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "proposal.dismiss", args: { proposal: PROPOSAL.slice(0, 10) }, office: OFFICE },
    ]);
    expect(ctx.out).toEqual(["dismissed proposal 3f3f3f3f3f3f; nothing is filed"]);
  });
});

describe("dipo propose usage", () => {
  it("needs accept or dismiss and one proposal id of 8 or more hex characters", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["propose"], ctx.deps)).toBe(2);
    expect(await main(["propose", "file", PROPOSAL], ctx.deps)).toBe(2);
    expect(await main(["propose", "accept"], ctx.deps)).toBe(2);
    expect(await main(["propose", "accept", "3f3f"], ctx.deps)).toBe(2);
    expect(await main(["propose", "accept", "prp_01J"], ctx.deps)).toBe(2);
    expect(await main(["propose", "accept", PROPOSAL, PROPOSAL], ctx.deps)).toBe(2);
    expect(await main(["propose", "accept", PROPOSAL, "--yes"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });

  it("is in the help", () => {
    expect(HELP).toContain("dipo propose accept|dismiss <proposal> [--office <id>]");
  });
});
