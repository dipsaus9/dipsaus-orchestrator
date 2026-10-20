// `dipo hold` and `dipo drop` (DIPO-160): hold needs a note and asks nothing; drop asks yes or no
// (`confirm: true`), and with `--delete-branch` (`irreversibleWhen`) the story id typed out, which
// `--yes` does not replace.

import { describe, expect, it } from "bun:test";

import { type OfficeId, storyDrop } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspace, type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";

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

const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const done = () => ({ ok: true, changed: true, result: { story: "DIPO-7", key: KEY } });

describe("dipo hold", () => {
  it("sends story.hold with the note and asks nothing", async () => {
    const ctx = fake(done, { interactive: true });
    expect(await main(["hold", "dipo-7", "--note", "after M2"], ctx.deps)).toBe(0);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.sent).toEqual([
      { name: "story.hold", args: { story: "DIPO-7", note: "after M2" }, office: OFFICE },
    ]);
    expect(ctx.out[0]).toContain("held DIPO-7");
  });

  it("needs a story id and a note", async () => {
    expect(await main(["hold", "DIPO-7"], fake(done).deps)).toBe(2);
    expect(await main(["hold", "--note", "x"], fake(done).deps)).toBe(2);
    expect(await main(["hold", "DIPO-7", "--note"], fake(done).deps)).toBe(2);
  });

  it("prints story.notHoldable from the engine and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "story.notHoldable",
        message: "DIPO-7 is running; stop it with `dipo stop DIPO-7` first.",
        retryable: false,
      },
    }));
    expect(await main(["hold", "DIPO-7", "--note", "x"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("story.notHoldable");
    expect(ctx.err[0]).toContain("dipo stop");
  });
});

describe("dipo drop", () => {
  it("is a confirm command whose irreversibility depends on deleteBranch", () => {
    expect(storyDrop.confirm).toBe(true);
    expect(storyDrop.irreversible).toBe(false);
    expect(storyDrop.irreversibleWhen).toEqual(["deleteBranch"]);
  });

  it("asks yes or no, then sends story.drop with the branch kept", async () => {
    const ctx = fake(done, { interactive: true, answers: ["y"] });
    expect(await main(["drop", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.ws.questions[0]).toContain("Drop DIPO-7?");
    expect(ctx.sent).toEqual([
      { name: "story.drop", args: { story: "DIPO-7", deleteBranch: false }, office: OFFICE },
    ]);
    expect(ctx.out[0]).toContain("its branch is kept");
  });

  it("sends nothing when the answer is no, and refuses without a terminal unless --yes", async () => {
    const no = fake(done, { interactive: true, answers: ["n"] });
    expect(await main(["drop", "DIPO-7"], no.deps)).toBe(1);
    expect(no.sent).toEqual([]);
    const refused = fake(done);
    expect(await main(["drop", "DIPO-7"], refused.deps)).toBe(1);
    expect(refused.err[0]).toContain("needs confirmation");
    const yes = fake(done);
    expect(await main(["drop", "DIPO-7", "--yes"], yes.deps)).toBe(0);
    expect(yes.sent.map((s) => s.name)).toEqual(["story.drop"]);
  });

  it("asks for the story id typed out with --delete-branch, which --yes does not replace", async () => {
    const typed = fake(done, { interactive: true, answers: ["dipo-7"] });
    expect(await main(["drop", "DIPO-7", "--delete-branch"], typed.deps)).toBe(0);
    expect(typed.ws.questions[0]).toContain("cannot be undone");
    expect(typed.ws.questions[0]).toContain("Type DIPO-7");
    expect(typed.sent).toEqual([
      { name: "story.drop", args: { story: "DIPO-7", deleteBranch: true }, office: OFFICE },
    ]);

    const wrong = fake(done, { interactive: true, answers: ["y"] });
    expect(await main(["drop", "DIPO-7", "--delete-branch", "--yes"], wrong.deps)).toBe(1);
    expect(wrong.sent).toEqual([]);

    const script = fake(done);
    expect(await main(["drop", "DIPO-7", "--delete-branch", "--yes"], script.deps)).toBe(1);
    expect(script.sent).toEqual([]);
    expect(script.err[0]).toContain("typed at a terminal");
  });

  it("prints story.dirtyWorktree with the files and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "story.dirtyWorktree",
        message: "The worktree of DIPO-7 has uncommitted or untracked files: a.ts.",
        retryable: false,
      },
    }));
    expect(await main(["drop", "DIPO-7", "--yes"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("a.ts");
  });

  it("needs exactly one story id", async () => {
    expect(await main(["drop"], fake(done).deps)).toBe(2);
    expect(await main(["drop", "DIPO-7", "DIPO-8"], fake(done).deps)).toBe(2);
  });
});
