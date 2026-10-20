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

/** `story.losses` as the engine answers it when nothing is lost. */
const NOTHING_LOST = () => ({
  ok: true,
  result: { story: "DIPO-7", key: KEY, commits: [], files: [] },
});

/** `story.losses` as the engine answers it for one commit and one untracked file. */
const LOST = () => ({
  ok: true,
  result: {
    story: "DIPO-7",
    key: KEY,
    commits: [{ sha: "3f9a1c2", subject: "feat(DIPO-7): retry" }],
    files: ["scratch.txt"],
  },
});

function fake(
  reply: (sent: Sent) => unknown,
  workspace: FakeWorkspaceOptions = {},
  readReply: () => unknown = NOTHING_LOST,
) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const reads: string[] = [];
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
        read: (async (definition: { name: string }) => {
          reads.push(definition.name);
          return readReply();
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
  return { deps, out, err, sent, reads, ws };
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

  it("lists the commits and files it loses before the typed id is asked (DIPO-228)", async () => {
    const ctx = fake(done, { interactive: true, answers: ["DIPO-7"] }, LOST);
    // What was printed when the question was asked: the lists come first.
    const printedAtQuestion: string[][] = [];
    const ask = ctx.ws.ask;
    ctx.ws.ask = async (question) => {
      printedAtQuestion.push([...ctx.out]);
      return ask(question);
    };
    expect(await main(["drop", "DIPO-7", "--delete-branch"], ctx.deps)).toBe(0);
    expect(ctx.reads).toEqual(["story.losses"]);
    expect(ctx.out).toEqual([
      "commits not on the base (1):",
      "  3f9a1c2 feat(DIPO-7): retry",
      "uncommitted or untracked files (1):",
      "  scratch.txt",
      "dropped DIPO-7; it is archived, its worktree and branch are removed",
    ]);
    expect(printedAtQuestion[0]).toEqual(ctx.out.slice(0, 4));
    expect(ctx.ws.questions[0]).toContain("cannot be undone");
    expect(ctx.ws.questions[0]).toContain("Type DIPO-7");
  });

  it("caps the lists at 20 commits and 50 files with a count of the rest", async () => {
    const commits = Array.from({ length: 22 }, (_, i) => ({
      sha: `sha${i}`,
      subject: `commit ${i}`,
    }));
    const files = Array.from({ length: 51 }, (_, i) => `file-${i}.txt`);
    const ctx = fake(done, { interactive: true, answers: ["DIPO-7"] }, () => ({
      ok: true,
      result: { story: "DIPO-7", key: KEY, commits, files },
    }));
    expect(await main(["drop", "DIPO-7", "--delete-branch"], ctx.deps)).toBe(0);
    expect(ctx.out).toContain("commits not on the base (22):");
    expect(ctx.out).toContain("  sha19 commit 19");
    expect(ctx.out).not.toContain("  sha20 commit 20");
    expect(ctx.out).toContain("  and 2 more");
    expect(ctx.out).toContain("uncommitted or untracked files (51):");
    expect(ctx.out).toContain("  file-49.txt");
    expect(ctx.out).not.toContain("  file-50.txt");
    expect(ctx.out).toContain("  and 1 more");
  });

  it("says that no commits or files are lost when the read finds none", async () => {
    const ctx = fake(done, { interactive: true, answers: ["DIPO-7"] });
    expect(await main(["drop", "DIPO-7", "--delete-branch"], ctx.deps)).toBe(0);
    expect(ctx.out[0]).toBe("no commits or files are lost");
    expect(ctx.sent.map((s) => s.name)).toEqual(["story.drop"]);
  });

  it("drops nothing and prints why when the loss read fails", async () => {
    const ctx = fake(done, { interactive: true, answers: ["DIPO-7"] }, () => ({
      ok: false,
      error: {
        code: "git.failed",
        message: "git could not read the branch DIPO-7/work",
        retryable: false,
      },
    }));
    expect(await main(["drop", "DIPO-7", "--delete-branch"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("git.failed");
    expect(ctx.err[0]).toContain("could not read the branch");
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.sent).toEqual([]);
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
