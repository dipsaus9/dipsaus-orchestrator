// `dipo answer <question> <text|allow|deny>` (DIPO-59 AC #7): sends `work.answer` with the decision
// for allow and deny (a deny's further words are the reason), or the text alone.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
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

const QUESTION = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const answered = () => ({
  ok: true,
  changed: true,
  result: { question: QUESTION, delivered: "now" },
});

describe("dipo answer", () => {
  it("sends allow as the decision with an empty text", async () => {
    const ctx = fake(answered);
    expect(await main(["answer", QUESTION, "allow"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      {
        name: "work.answer",
        args: { question: QUESTION, text: "", decision: "allow" },
        office: OFFICE,
      },
    ]);
    expect(ctx.out).toEqual([`allowed ${QUESTION} (delivered now)`]);
  });

  it("sends deny with the rest as the reason, and plain text without a decision", async () => {
    const deny = fake(answered);
    expect(await main(["answer", QUESTION, "deny", "use", "the", "fixture"], deny.deps)).toBe(0);
    expect(deny.sent[0]?.args).toEqual({
      question: QUESTION,
      text: "use the fixture",
      decision: "deny",
    });
    const text = fake(answered);
    expect(
      await main(["answer", QUESTION, "Yes, a 404 is fine.", "--office", OFFICE], text.deps),
    ).toBe(0);
    expect(text.sent[0]?.args).toEqual({ question: QUESTION, text: "Yes, a 404 is fine." });
  });

  it("prints the resumed run of a park's question (DIPO-75 AC #5)", async () => {
    const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5J";
    const resumed = fake(() => ({
      ok: true,
      changed: true,
      result: { question: QUESTION, delivered: "on-resume", run: RUN },
    }));
    expect(await main(["answer", QUESTION, "allow"], resumed.deps)).toBe(0);
    expect(resumed.out).toEqual([
      `allowed ${QUESTION} (delivered on-resume)`,
      `resumed run ${RUN}`,
    ]);
    const denied = fake(() => ({
      ok: true,
      changed: true,
      result: { question: QUESTION, delivered: "on-resume" },
    }));
    expect(await main(["answer", QUESTION, "deny"], denied.deps)).toBe(0);
    expect(denied.out).toEqual([
      `denied ${QUESTION} (delivered on-resume)`,
      "the story did not resume; dipo watch shows where it is now",
    ]);
  });

  it("prints the engine's error and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "question.closed", message: "It is not waiting.", retryable: false },
    }));
    expect(await main(["answer", QUESTION, "allow"], ctx.deps)).toBe(1);
    expect(ctx.err).toEqual(["dipo: question.closed: It is not waiting."]);
  });

  it("needs a question id and an answer", async () => {
    expect(await main(["answer"], fake(answered).deps)).toBe(2);
    expect(await main(["answer", "DIPO-7", "allow"], fake(answered).deps)).toBe(2);
    expect(await main(["answer", QUESTION], fake(answered).deps)).toBe(2);
    expect(await main(["answer", QUESTION, "allow", "now"], fake(answered).deps)).toBe(2);
  });
});
