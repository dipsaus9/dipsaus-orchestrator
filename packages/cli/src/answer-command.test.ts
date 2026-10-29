// `dipo answer <question> --text <answer>` (DIPO-59, DIPO-159, DIPO-344): sends `work.answer` with
// the text of `--text`; text without `--text` is a usage error, and an answer is never a decision.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import {
  type FakeWorkspace,
  type FakeWorkspaceOptions,
  fakeWorkspace,
} from "../test/support/fake-workspace";
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

const QUESTION = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const answered = () => ({
  ok: true,
  changed: true,
  result: { question: QUESTION, delivered: "now" },
});

describe("dipo answer", () => {
  it("sends --text as the answer", async () => {
    const text = fake(answered);
    expect(
      await main(
        ["answer", QUESTION, "--text", "Yes, a 404 is fine.", "--office", OFFICE],
        text.deps,
      ),
    ).toBe(0);
    expect(text.sent[0]?.args).toEqual({ question: QUESTION, text: "Yes, a 404 is fine." });
    expect(text.out).toEqual([`answered ${QUESTION} (delivered now)`]);
  });

  it("sends --text allow as an answer text, never as a decision (DIPO-159, 0020 section 7)", async () => {
    const ctx = fake(answered);
    expect(await main(["answer", QUESTION, "--text", "allow"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "work.answer", args: { question: QUESTION, text: "allow" }, office: OFFICE },
    ]);
  });

  it("refuses an answer without --text, a bare allow or deny, and --text with extra words", async () => {
    for (const args of [
      ["answer", QUESTION, "Yes, a 404 is fine."],
      ["answer", QUESTION, "allow"],
      ["answer", QUESTION, "deny", "use", "the", "fixture"],
      ["answer", QUESTION, "--text", "yes", "allow"],
      ["answer", QUESTION, "allow", "--text", "yes"],
      ["answer", QUESTION, "--text"],
      ["answer", QUESTION, "--text", "  "],
      ["answer", QUESTION, "--text", "a", "--text", "b"],
    ]) {
      const ctx = fake(answered);
      expect(await main(args, ctx.deps)).toBe(2);
      expect(ctx.sent).toEqual([]);
    }
    const ctx = fake(answered);
    await main(["answer", QUESTION, "Yes"], ctx.deps);
    expect(ctx.err.join("\n")).toContain("--text <answer>");
  });

  it("prints that a held answer waits for the next session, and the resumed run of a question park", async () => {
    const held = fake(() => ({
      ok: true,
      changed: true,
      result: { question: QUESTION, delivered: "on-resume" },
    }));
    expect(await main(["answer", QUESTION, "--text", "Use hello"], held.deps)).toBe(0);
    expect(held.out).toEqual([
      `answered ${QUESTION} (delivered on-resume)`,
      "the answer waits for the story's next session; dipo watch shows where it is now",
    ]);
    const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5J";
    const resumed = fake(() => ({
      ok: true,
      changed: true,
      result: { question: QUESTION, delivered: "on-resume", run: RUN },
    }));
    expect(await main(["answer", QUESTION, "--text", "Use hello"], resumed.deps)).toBe(0);
    expect(resumed.out).toEqual([
      `answered ${QUESTION} (delivered on-resume)`,
      `resumed run ${RUN}`,
    ]);
  });

  it("says in its help that an answer takes --text, and offers no allow or deny", async () => {
    const out: string[] = [];
    const ctx = fake(answered);
    await main(["--help"], { ...ctx.deps, writeLine: (line) => out.push(line) });
    const help = out.join("\n");
    expect(help).toContain("dipo answer <question> --text <answer>");
    expect(help).not.toContain("allow|deny");
  });

  it("prints the engine's error and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "question.closed", message: "It is not waiting.", retryable: false },
    }));
    expect(await main(["answer", QUESTION, "--text", "yes"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: question.closed: It is not waiting."]);
  });

  it("needs a question id and an answer", async () => {
    expect(await main(["answer"], fake(answered).deps)).toBe(2);
    expect(await main(["answer", "DIPO-7", "--text", "yes"], fake(answered).deps)).toBe(2);
    expect(await main(["answer", QUESTION], fake(answered).deps)).toBe(2);
  });
});
