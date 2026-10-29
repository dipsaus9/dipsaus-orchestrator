// `dipo approve` and `dipo reject` (DIPO-150 with DIPO-151; 0019 section 11): both read the story's
// open gate that waits for the maintainer from `story.detail` and send its id; with none they print
// that nothing waits and exit 1. Reject needs a note and asks yes or no first (`confirm: true`).

import { describe, expect, it } from "bun:test";

import { gateReject, type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "../test/support/fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const GATE = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C7K";
const OLDER = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C6J";
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

const gateView = (gate: string) => ({
  gate,
  work: {
    story: "DIPO-7",
    key: KEY,
    run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E",
    agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F",
    role: "developer",
    tier: "M",
    model: "sonnet",
  },
  kind: "merge",
  waitingOn: "maintainer",
  summary: "DIPO-7: PR #7 waits for the maintainer",
});

/** `story.detail` with the given open gates. */
const detail = (gates: unknown[] | undefined) => () => ({
  ok: true,
  result: { view: {}, runs: [], verdicts: [], ...(gates === undefined ? {} : { gates }) },
});

function fake(
  reply: (sent: Sent) => unknown,
  readReply: () => unknown,
  workspace: FakeWorkspaceOptions = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const reads: { name: string; args: unknown }[] = [];
  const ws = fakeWorkspace({ cwd: "/work/app", ...IN_OFFICE, ...workspace });
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
          reads.push({ name: definition.name, args });
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

const approved = () => ({ ok: true, changed: true, result: { gate: GATE, decision: "approved" } });
const rejected = () => ({ ok: true, changed: true, result: { gate: GATE, decision: "rejected" } });

describe("dipo approve", () => {
  it("reads the story's open maintainer gate from story.detail and sends gate.approve with its id", async () => {
    const ctx = fake(approved, detail([gateView(OLDER), gateView(GATE)]), { interactive: true });
    expect(await main(["approve", "dipo-7", "--note", "tested"], ctx.deps)).toBe(0);
    expect(ctx.reads).toEqual([
      { name: "story.detail", args: { office: OFFICE, story: "DIPO-7" } },
    ]);
    expect(ctx.sent).toEqual([
      { name: "gate.approve", args: { gate: GATE, note: "tested" }, office: OFFICE },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out[0]).toContain("approved the merge of DIPO-7");
  });

  it("sends no note when none is given", async () => {
    const ctx = fake(approved, detail([gateView(GATE)]));
    expect(await main(["approve", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.sent[0]?.args).toEqual({ gate: GATE });
  });

  it("prints that nothing waits and exits 1 when no gate waits for the maintainer", async () => {
    const ctx = fake(approved, detail(undefined));
    expect(await main(["approve", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([]);
    expect(ctx.out).toEqual(["nothing waits for you on DIPO-7"]);
  });

  it("prints gate.noteRequired from the engine and exits 1", async () => {
    const ctx = fake(
      () => ({
        ok: false,
        error: {
          code: "gate.noteRequired",
          message: "Approving past a blocked review needs a note.",
          retryable: false,
        },
      }),
      detail([gateView(GATE)]),
    );
    expect(await main(["approve", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("gate.noteRequired");
  });

  it("needs a story id", async () => {
    expect(await main(["approve"], fake(approved, detail(undefined)).deps)).toBe(2);
    expect(
      await main(["approve", "DIPO-7", "--note"], fake(approved, detail(undefined)).deps),
    ).toBe(2);
  });
});

describe("dipo reject", () => {
  it("is a confirm command", () => {
    expect(gateReject.confirm).toBe(true);
  });

  it("asks yes or no, then sends gate.reject with the gate id and the note", async () => {
    const ctx = fake(rejected, detail([gateView(GATE)]), { interactive: true, answers: ["y"] });
    expect(await main(["reject", "DIPO-7", "--note", "The greeting is wrong."], ctx.deps)).toBe(0);
    expect(ctx.ws.questions[0]).toContain("Reject the merge of DIPO-7?");
    expect(ctx.sent).toEqual([
      {
        name: "gate.reject",
        args: { gate: GATE, note: "The greeting is wrong." },
        office: OFFICE,
      },
    ]);
    expect(ctx.out.at(-1)).toContain("rejected the merge of DIPO-7");
  });

  it("needs a note, sends nothing on no, and refuses without a terminal unless --yes", async () => {
    expect(await main(["reject", "DIPO-7"], fake(rejected, detail([gateView(GATE)])).deps)).toBe(2);
    const no = fake(rejected, detail([gateView(GATE)]), { interactive: true, answers: ["n"] });
    expect(await main(["reject", "DIPO-7", "--note", "x"], no.deps)).toBe(1);
    expect(no.sent).toEqual([]);
    const script = fake(rejected, detail([gateView(GATE)]));
    expect(await main(["reject", "DIPO-7", "--note", "x"], script.deps)).toBe(1);
    expect(script.err[0]).toContain("needs confirmation");
    const yes = fake(rejected, detail([gateView(GATE)]));
    expect(await main(["reject", "DIPO-7", "--note", "x", "--yes"], yes.deps)).toBe(0);
    expect(yes.sent.map((s) => s.name)).toEqual(["gate.reject"]);
  });

  it("prints that nothing waits and exits 1 before it asks anything", async () => {
    const ctx = fake(rejected, detail([]), { interactive: true, answers: ["y"] });
    expect(await main(["reject", "DIPO-7", "--note", "x"], ctx.deps)).toBe(1);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.sent).toEqual([]);
    expect(ctx.out).toEqual(["nothing waits for you on DIPO-7"]);
  });
});
