// `dipo test` (DIPO-309, 0002): `dipo test <id>` sends `test.start` and prints the URL, the test
// box, the numbered steps and the test id; `dipo test pass` and `dipo test fail` send
// `test.record` for the story's open test from `office.snapshot`, and a fail without `--note` is
// refused before anything is sent; `dipo test shell` opens the daemon-side shell in the test box.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const TEST = "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C7K";
const BOX = `dipo-${TEST}`;
const HEAD = "4b4171c2a1e3f5d7b9c0e2f4a6b8d0c2e4f6a8b0";

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

const STEPS = [{ check: "Open the overview", expect: "Three offices show" }, { check: "Press o" }];

const started = {
  test: TEST,
  head: HEAD,
  checkout: BOX,
  steps: STEPS,
  url: "http://localhost:52731/",
  shell: "dipo test shell DIPO-7",
};

const snapshot = (tests: unknown[]) => ({
  ok: true,
  result: {
    cursor: { stream: `office:${OFFICE}`, seq: 1 },
    stories: [],
    work: [],
    gates: [],
    questions: [],
    tests,
  },
});

const openTest = {
  ...started,
  story: "DIPO-7",
  key: KEY,
  startedAt: "2026-10-28T10:00:00.000Z",
};

type Sent = { name: string; args: unknown; office: unknown };

function fake(
  reply: (sent: Sent) => unknown,
  readReply: () => unknown = () => snapshot([openTest]),
) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const reads: string[] = [];
  const forms: string[][] = [];
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async (argv) => {
      forms.push([...argv]);
      return 0;
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
    runtime: { bun: "1.4.2", os: "darwin", arch: "arm64" },
    workspace: fakeWorkspace({
      cwd: "/work/app",
      repository: {
        mainWorktree: "/work/app",
        commonDir: "/work/app/.git",
        office: OFFICE,
        backlog: true,
      },
    }),
  };
  return { deps, out, err, sent, reads, forms };
}

describe("dipo test <id>", () => {
  it("sends test.start and prints the URL, the box, the numbered steps and the test id", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: started }));
    expect(await main(["test", "dipo-7"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "test.start", args: { story: "DIPO-7" }, office: OFFICE }]);
    const text = ctx.out.join("\n");
    expect(text).toContain(`testing DIPO-7 at ${HEAD.slice(0, 12)} in the test box ${BOX}`);
    expect(text).toContain("open http://localhost:52731/");
    expect(text).toContain("shell: dipo test shell DIPO-7");
    expect(text).toContain("  1. Open the overview\n     expect: Three offices show\n  2. Press o");
    expect(text).toContain(`test: ${TEST}`);
  });

  it("says when the product has nothing to start, and shows an engine refusal", async () => {
    const { url: _url, ...noUrl } = started;
    const ctx = fake(() => ({ ok: true, changed: true, result: noUrl }));
    expect(await main(["test", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.out.join("\n")).toContain("nothing to start");
    const refused = fake(() => ({
      ok: false,
      error: { code: "test.notInReview", message: "DIPO-7 cannot be tested.", retryable: false },
    }));
    expect(await main(["test", "DIPO-7"], refused.deps)).toBe(1);
    expect(refused.err.join("\n")).toContain("test.notInReview");
  });
});

describe("dipo test pass and fail", () => {
  it("send test.record for the story's open test", async () => {
    const pass = fake(() => ({ ok: true, changed: true, result: { test: TEST, result: "pass" } }));
    expect(await main(["test", "pass", "DIPO-7"], pass.deps)).toBe(0);
    expect(pass.reads).toEqual(["office.snapshot"]);
    expect(pass.sent).toEqual([
      { name: "test.record", args: { test: TEST, result: "pass" }, office: OFFICE },
    ]);
    const fail = fake(() => ({ ok: true, changed: true, result: { test: TEST, result: "fail" } }));
    expect(await main(["test", "fail", KEY, "--note", "Esc does not go back"], fail.deps)).toBe(0);
    expect(fail.sent).toEqual([
      {
        name: "test.record",
        args: { test: TEST, result: "fail", note: "Esc does not go back" },
        office: OFFICE,
      },
    ]);
    expect(fail.out.join("\n")).toContain("your note goes to its worker");
  });

  it("refuses a fail without --note before anything is sent, and a story with no open test", async () => {
    const ctx = fake(() => {
      throw new Error("nothing may be sent");
    });
    expect(await main(["test", "fail", "DIPO-7"], ctx.deps)).toBe(2);
    expect(ctx.err.join("\n")).toContain("test fail needs --note");
    expect(ctx.sent).toEqual([]);
    const none = fake(
      () => {
        throw new Error("nothing may be sent");
      },
      () => snapshot([]),
    );
    expect(await main(["test", "pass", "DIPO-7"], none.deps)).toBe(1);
    expect(none.out.join("\n")).toContain("DIPO-7 has no open test");
  });
});

describe("dipo test shell", () => {
  it("opens the daemon-side shell in the story's test box", async () => {
    const ctx = fake(() => {
      throw new Error("nothing may be sent");
    });
    expect(await main(["test", "shell", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.forms).toEqual([["test-shell", BOX]]);
    expect(ctx.sent).toEqual([]);
  });
});
