// `dipo resume <id>` (DIPO-155): sends `work.resume` with the note, prints where the story went,
// the grants and a queued session; `--budget` is confirmed first from the caps the engine shows in
// `confirmation.required`, `--yes` answers for a script, and without a terminal a top-up refuses.

import { describe, expect, it } from "bun:test";

import { type OfficeId, workResume } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import { type FakeWorkspace, type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { parseBudget } from "./resume-command";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C5K";
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

type Sent = { name: string; args: unknown; office: unknown; confirmed: unknown };

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
          const given = options as { office?: unknown; confirmed?: unknown } | undefined;
          const message = {
            name: definition.name,
            args,
            office: given?.office,
            confirmed: given?.confirmed,
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

const resumed = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  changed: true,
  result: { story: "DIPO-7", key: KEY, to: "In Progress", run: RUN, ...extra },
});

const confirmFirst = (sent: Sent) =>
  sent.confirmed === true
    ? resumed({ grants: [{ kind: "budget", tokens: 150_000, turns: 30, minutes: 15 }] })
    : {
        ok: false,
        error: {
          code: "confirmation.required",
          message: "Raising DIPO-7's caps needs confirmation.",
          retryable: false,
          details: {
            before: { budgetTokens: 300_000, maxTurns: 60, maxMinutes: 30 },
            after: { budgetTokens: 450_000, maxTurns: 90, maxMinutes: 45 },
          },
        },
      };

describe("dipo resume", () => {
  it("declares confirmWhen budget in the contract", () => {
    expect(workResume.confirmWhen).toEqual(["budget"]);
  });

  it("sends work.resume with the note and prints where the story went", async () => {
    const ctx = fake(() => resumed());
    expect(await main(["resume", "dipo-7", "--note", "Keep the old flag."], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      {
        name: "work.resume",
        args: { story: "DIPO-7", note: "Keep the old flag." },
        office: OFFICE,
        // Nothing was asked, so nothing is sent confirmed.
        confirmed: false,
      },
    ]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([`resumed DIPO-7 (run ${RUN}); it is In Progress`]);
  });

  it("sends confirmed only with --yes when nothing was asked", async () => {
    const ctx = fake(() => resumed());
    expect(await main(["resume", "DIPO-7", "--yes"], ctx.deps)).toBe(0);
    expect(ctx.sent.map((sent) => sent.confirmed)).toEqual([true]);
  });

  it("prints the queued reply when the session waits for its place", async () => {
    const ctx = fake(() => resumed({ queued: true }));
    expect(await main(["resume", "DIPO-7"], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      `resumed DIPO-7 (run ${RUN}); it is In Progress; its session starts when the office's place frees`,
    ]);
  });

  it("prints the recorded grants", async () => {
    const ctx = fake(() => resumed({ grants: [{ kind: "round", cap: "loops", count: 1 }] }));
    expect(await main(["resume", "DIPO-7", "--note", "Try once more."], ctx.deps)).toBe(0);
    expect(ctx.out[1]).toBe("granted: one more verify loop");
  });

  it("shows the caps before and after a top-up, asks, then sends it confirmed", async () => {
    const ctx = fake(confirmFirst, { interactive: true, answers: ["y"] });
    expect(
      await main(["resume", "DIPO-7", "--budget", "+50%", "--note", "DIPO-105 again"], ctx.deps),
    ).toBe(0);
    expect(ctx.sent.map((sent) => [sent.args, sent.confirmed])).toEqual([
      [{ story: "DIPO-7", note: "DIPO-105 again", budget: { share: 50 } }, false],
      [{ story: "DIPO-7", note: "DIPO-105 again", budget: { share: 50 } }, true],
    ]);
    expect(ctx.ws.questions).toEqual(["Raise DIPO-7's caps and resume it? [y/N] "]);
    expect(ctx.out).toEqual([
      "Top up DIPO-7: its caps go from the left to the right.",
      "  tokens  300,000 -> 450,000",
      "  turns        60 -> 90",
      "  minutes      30 -> 45",
      `resumed DIPO-7 (run ${RUN}); it is In Progress`,
      "granted: +150,000 tokens, +30 turns and +15 minutes",
    ]);
  });

  it("sends nothing confirmed when the answer is no", async () => {
    const ctx = fake(confirmFirst, { interactive: true, answers: ["n"] });
    expect(await main(["resume", "DIPO-7", "--budget", "+50%", "--note", "x"], ctx.deps)).toBe(1);
    expect(ctx.sent.map((sent) => sent.confirmed)).toEqual([false]);
    expect(ctx.out.at(-1)).toBe("nothing resumed");
  });

  it("refuses a top-up without a terminal unless --yes is given", async () => {
    const refused = fake(confirmFirst);
    expect(await main(["resume", "DIPO-7", "--budget", "+50%", "--note", "x"], refused.deps)).toBe(
      1,
    );
    expect(refused.sent).toEqual([]);
    expect(refused.err[0]).toContain("needs confirmation");

    const yes = fake(confirmFirst);
    expect(
      await main(["resume", "DIPO-7", "--budget", "+200000", "--note", "x", "--yes"], yes.deps),
    ).toBe(0);
    expect(yes.ws.questions).toEqual([]);
    expect(yes.sent.map((sent) => [sent.args, sent.confirmed])).toEqual([
      [{ story: "DIPO-7", note: "x", budget: { tokens: 200_000 } }, true],
    ]);
  });

  it("prints a resume refusal from the engine and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: {
        code: "resume.topUpRequired",
        message:
          "DIPO-7 parked as budget-exceeded (build) on its turn cap (turn cap reached: 61 of 60 turns). Resume with `dipo resume DIPO-7 --budget +50% --note <why>`.",
        retryable: false,
      },
    }));
    expect(await main(["resume", "DIPO-7"], ctx.deps)).toBe(1);
    expect(ctx.err[0]).toContain("dipo: resume.topUpRequired: DIPO-7 parked as budget-exceeded");
  });

  it("reads +N% and +<tokens>, and refuses anything else", async () => {
    expect(parseBudget("+50%")).toEqual({ share: 50 });
    expect(parseBudget("+12.5%")).toEqual({ share: 12.5 });
    expect(parseBudget("+200000")).toEqual({ tokens: 200_000 });
    expect(parseBudget("+200,000")).toEqual({ tokens: 200_000 });
    expect(parseBudget("50%")).toBeNull();
    expect(parseBudget("+0%")).toBeNull();
    expect(parseBudget("-5%")).toBeNull();
    expect(await main(["resume", "DIPO-7", "--budget", "lots"], fake(() => resumed()).deps)).toBe(
      2,
    );
  });

  it("needs exactly one story id and a text after --note", async () => {
    expect(await main(["resume"], fake(() => resumed()).deps)).toBe(2);
    expect(await main(["resume", "DIPO-7", "DIPO-8"], fake(() => resumed()).deps)).toBe(2);
    expect(await main(["resume", "DIPO-7", "--note"], fake(() => resumed()).deps)).toBe(2);
  });
});
