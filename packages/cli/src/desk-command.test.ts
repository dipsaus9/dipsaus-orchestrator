// `dipo desk [--office <id>] [--json]` (DIPO-158; 0020 section 12): reads `office.desk` and prints a
// count line, one line per item with an indented command line, and the stories parked by you apart; an
// empty desk prints `Nothing waits on you.`; `--json` prints the read's result; the exit code is 0.

import { describe, expect, it } from "bun:test";

import { DeskItem, type OfficeId, officeDesk } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { ConnectMode, DaemonControl, DaemonSession } from "./daemon-commands";
import { age, EMPTY_DESK, formatDesk } from "./desk-command";
import { fakeWorkspace, type FakeWorkspaceOptions } from "./fake-workspace";
import { main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const REPO = {
  mainWorktree: "/work/dipsaus-orchestrator",
  commonDir: "/work/dipsaus-orchestrator/.git",
};
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const MINUTE = 60_000;

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

type Sent = { name: string; args: unknown };

function fake(reply: (sent: Sent) => unknown, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const modes: ConnectMode[] = [];
  const ws = fakeWorkspace({
    cwd: "/work/dipsaus-orchestrator/src",
    repository: { ...REPO, office: OFFICE, backlog: true },
    ...workspace,
  });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async (mode) => {
      modes.push(mode);
      const session: DaemonSession = {
        command: (async () => {
          throw new Error("command must not be called");
        }) as DaemonSession["command"],
        read: (async (definition: { name: string }, args: unknown) => {
          const message = { name: definition.name, args };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["read"],
        subscribe: () => {
          throw new Error("subscribe must not be called");
        },
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(NOW),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent, modes, questions: ws.questions };
}

function ago(minutes: number): string {
  return new Date(NOW - minutes * MINUTE).toISOString();
}

// The example of 0020 section 12, as the engine returns it.
const EXAMPLE: DeskItem[] = officeDesk.result.parse([
  {
    kind: "QUESTION",
    story: "DIPO-140",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
    question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
    detail: '"Keep the old flag?" · worker waiting',
    since: ago(6),
    blocks: [],
    actions: [
      { command: "work.answer", cli: 'dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A "<answer>"' },
    ],
  },
  {
    kind: "PARKED",
    story: "DIPO-105",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1B",
    reason: "budget-exceeded",
    detail: "turn cap 61 of 60 · 7 files uncommitted",
    since: ago(9 * 60),
    blocks: [],
    actions: [{ command: "work.resume", cli: 'dipo resume DIPO-105 --budget +50% --note "<why>"' }],
  },
  {
    kind: "LEFTOVERS",
    story: "DIPO-98",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
    detail: "Done on main (a1b2c3d) · branch has 3 commits not on main",
    since: ago(24 * 60),
    blocks: [],
    actions: [{ command: "work.discard", cli: 'dipo discard DIPO-98 --note "<why>"' }],
  },
  {
    kind: "PROPOSAL",
    story: "DIPO-122",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
    proposal: { id: "prp1", kind: "follow-up", title: "Split RunOutcomes" },
    detail: 'follow-up "Split RunOutcomes" · from run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E',
    since: ago(2 * 24 * 60),
    blocks: [],
    actions: [
      { command: "proposal.accept", cli: "dipo propose accept prp1" },
      { command: "proposal.dismiss", cli: "dipo propose dismiss prp1" },
    ],
  },
  {
    kind: "PARKED BY YOU",
    story: "DIPO-129",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1F",
    reason: "by-maintainer",
    detail: "after M2",
    since: ago(3 * 24 * 60),
    blocks: [],
    actions: [{ command: "work.resume", cli: "dipo resume DIPO-129" }],
  },
]);

/** A story the maintainer parked with no note, like the example's. */
function byYou(story: string): DeskItem {
  return DeskItem.parse({ ...EXAMPLE[4], story, detail: "" });
}

const EXAMPLE_LINES = [
  "dipsaus-orchestrator · desk 4 · parked by you 1",
  'QUESTION  DIPO-140  "Keep the old flag?" · worker waiting  6m',
  '          dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A "<answer>"',
  "PARKED    DIPO-105  budget-exceeded · turn cap 61 of 60 · 7 files uncommitted  9h",
  '          dipo resume DIPO-105 --budget +50% --note "<why>"',
  "LEFTOVERS DIPO-98   Done on main (a1b2c3d) · branch has 3 commits not on main  1d",
  '          dipo discard DIPO-98 --note "<why>"',
  'PROPOSAL  DIPO-122  follow-up "Split RunOutcomes" · from run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E  2d',
  "          dipo propose accept prp1 | dipo propose dismiss prp1",
  'Parked by you (1)  DIPO-129 "after M2"   dipo resume DIPO-129',
];

describe("formatDesk", () => {
  it("prints the 0020 example: a count line, each item with its command, parked by you apart", () => {
    expect(formatDesk("dipsaus-orchestrator", EXAMPLE, NOW)).toEqual(EXAMPLE_LINES);
  });

  it("ends the count line with today's and this month's tokens and UTC (DIPO-311)", () => {
    const lines = formatDesk("demo", EXAMPLE, NOW, [
      "today 1.2M of 4.0M tokens (30%, resets 00:00 UTC)",
      "this month 3k tokens",
    ]);
    expect(lines[0]).toBe(
      "demo · desk 4 · parked by you 1 · today 1.2M of 4.0M tokens (30%, resets 00:00 UTC) · this month 3k tokens",
    );
    expect(lines.slice(1)).toEqual(EXAMPLE_LINES.slice(1));
  });

  it("prints Nothing waits on you. for an empty desk", () => {
    expect(formatDesk("demo", [], NOW)).toEqual([EMPTY_DESK]);
    expect(EMPTY_DESK).toBe("Nothing waits on you.");
  });

  it("prints a hand action, an item with no command, and more stories parked by you below", () => {
    const merge = DeskItem.parse({
      kind: "MERGE",
      story: "DIPO-7",
      detail: "release PR",
      since: ago(0),
      blocks: [],
      actions: [],
      hand: "merge PR #7 by hand on GitHub",
    });
    const { hand: _, ...withoutHand } = merge;
    const bare = DeskItem.parse({ ...withoutHand, story: "DIPO-8" });
    expect(formatDesk("demo", [merge, bare, byYou("DIPO-1"), byYou("DIPO-22")], NOW)).toEqual([
      "demo · desk 2 · parked by you 2",
      "MERGE DIPO-7  release PR  0m",
      "      merge PR #7 by hand on GitHub",
      "MERGE DIPO-8  release PR  0m",
      "      (no command in this dipo yet)",
      "Parked by you (2)  DIPO-1  dipo resume DIPO-129",
      "                   DIPO-22 dipo resume DIPO-129",
    ]);
  });

  it("prints the office's starts paused first, with no story, its command and what lifts it (0020)", () => {
    const paused = DeskItem.parse({
      kind: "STARTS PAUSED",
      detail: "no new session starts · plan limit until 2026-10-23T14:00:00.000Z",
      since: ago(5),
      blocks: [],
      actions: [{ command: "daemon.resumeScheduling", cli: "dipo daemon resume-scheduling" }],
      hand: "It lifts by itself at 2026-10-23T14:02:00.000Z.",
    });
    expect(formatDesk("demo", [paused, byYou("DIPO-1")], NOW)).toEqual([
      "demo · desk 1 · parked by you 1",
      "STARTS PAUSED   no new session starts · plan limit until 2026-10-23T14:00:00.000Z  5m",
      "              dipo daemon resume-scheduling | It lifts by itself at 2026-10-23T14:02:00.000Z.",
      "Parked by you (1)  DIPO-1 dipo resume DIPO-129",
    ]);
  });

  it("shows the age in minutes, hours, then days", () => {
    expect(age(NOW - 59 * MINUTE, NOW)).toBe("59m");
    expect(age(NOW - 60 * MINUTE, NOW)).toBe("1h");
    expect(age(NOW - 47 * 60 * MINUTE, NOW)).toBe("1d");
    expect(age(NOW + MINUTE, NOW)).toBe("0m");
  });
});

describe("dipo desk", () => {
  it("reads office.desk for the office of the current directory without starting the daemon", async () => {
    const ctx = fake(() => ({ ok: true, result: EXAMPLE }));
    expect(await main(["desk"], ctx.deps)).toBe(0);
    expect(ctx.modes).toEqual(["running"]);
    expect(ctx.sent).toEqual([{ name: "office.desk", args: { office: OFFICE } }]);
    expect(ctx.out).toEqual(EXAMPLE_LINES);
    expect(ctx.err).toEqual([]);
  });

  it("prints Nothing waits on you. for an empty desk and exits 0", async () => {
    const ctx = fake(() => ({ ok: true, result: [] }));
    expect(await main(["desk", "--office", OFFICE], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual(["Nothing waits on you."]);
  });

  it("names the office by its id with --office", async () => {
    const ctx = fake(() => ({ ok: true, result: EXAMPLE.slice(0, 1) }));
    expect(await main(["desk", "--office", OFFICE], ctx.deps)).toBe(0);
    expect(ctx.out[0]).toBe(`${OFFICE} · desk 1 · parked by you 0`);
  });

  it("prints the read's result with --json", async () => {
    const ctx = fake(() => ({ ok: true, result: EXAMPLE }));
    expect(await main(["desk", "--json"], ctx.deps)).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual(EXAMPLE);
  });

  it("refuses an unknown argument with the usage exit code", async () => {
    const ctx = fake(() => ({ ok: true, result: [] }));
    expect(await main(["desk", "--all"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});

describe("dipo desk outside an office", () => {
  it("names a Backlog.md folder that is not an office and asks nothing, even at a terminal", async () => {
    const ctx = fake(() => ({ ok: true, result: [] }), {
      interactive: true,
      answers: ["y"],
      repository: { ...REPO, backlog: true },
    });
    expect(await main(["desk"], ctx.deps)).toBe(1);
    expect(ctx.questions).toEqual([]);
    expect(ctx.sent).toEqual([]);
    expect(ctx.err).toEqual([
      "dipo: /work/dipsaus-orchestrator is not an office; run `dipo office open` to open it.",
    ]);
    expect(ctx.out).toEqual([]);
  });

  it("asks nothing when the daemon does not know the office of the folder", async () => {
    const ctx = fake(
      () => ({ ok: false, error: { code: "office.unknown", message: "no such office" } }),
      { interactive: true, answers: ["y"] },
    );
    expect(await main(["desk"], ctx.deps)).toBe(1);
    expect(ctx.questions).toEqual([]);
    expect(ctx.sent.map((sent) => sent.name)).toEqual(["office.desk"]);
    expect(ctx.err).toEqual([
      "dipo: /work/dipsaus-orchestrator is not an office; run `dipo office open` to open it.",
    ]);
  });
});
