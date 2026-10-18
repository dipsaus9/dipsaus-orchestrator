// `dipo run [ID...]` (DIPO-48): sends `work.run` for the office of `--office` or of the current
// directory with the resolved main worktree as `from`, prints started and skipped stories with
// their reasons, and exits 0 only when a story started.

import { describe, expect, it } from "bun:test";

import type { Event, OfficeId } from "@dipsaus-orchestrator/contract";
import type { SubscribeOptions } from "@dipsaus-orchestrator/client";
import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { type DaemonControl, type DaemonSession, START_HINT } from "./daemon-commands";
import { type FakeWorkspaceOptions, fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { EXPLAIN_WAIT_MS } from "./run-command";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const OTHER = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F";
const KEY_2 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C4G";
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };
const IN_OFFICE = { repository: { ...REPO, office: OFFICE, backlog: true } };

type Sent = { name: string; args: unknown; office: unknown };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

function fake(
  reply: (sent: Sent) => unknown,
  workspace: FakeWorkspaceOptions = {},
  read?: (sent: Sent) => unknown,
) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const subscribed: string[] = [];
  const listeners = new Set<(event: Event) => void>();
  let seq = 0;
  const emit = (type: string, data: unknown) => {
    seq += 1;
    const event = {
      cursor: { stream: `office:${OFFICE}`, epoch: "e1", seq },
      at: "2026-10-14T09:00:00Z",
      type,
      data,
    } as unknown as Event;
    for (const listener of listeners) listener(event);
  };
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const session: DaemonSession = {
        command: (async (definition: { name: string }, args: unknown, options: unknown) => {
          const message = {
            name: definition.name,
            args,
            office: (options as { office?: unknown } | undefined)?.office,
          };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["command"],
        // The office stream: live at once; `emit` delivers an event to it.
        subscribe: ((stream: string, options: SubscribeOptions) => {
          subscribed.push(stream);
          listeners.add(options.onEvent);
          queueMicrotask(() => options.onCaughtUp?.(undefined as never));
          return {
            stream,
            cursor: undefined,
            unsubscribe: () => listeners.delete(options.onEvent),
          };
        }) as unknown as DaemonSession["subscribe"],
        read: (async (definition: { name: string }, args: unknown) => {
          if (read === undefined) throw new Error("read must not be called");
          const message = { name: definition.name, args, office: undefined };
          sent.push(message);
          return read(message);
        }) as DaemonSession["read"],
        close: () => undefined,
      };
      return session;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace({ cwd: "/work/app/src", ...workspace }),
  };
  return { deps, out, err, sent, emit, subscribed, listeners };
}

const result = (
  started: { story: string; key: string; run: string }[],
  skipped: { story: string; key: string; reason: string }[] = [],
) => ({ ok: true, changed: started.length > 0, result: { started, skipped } });

describe("dipo run explains its skips", () => {
  it("prints the notice of a failed setup and the gate output of a move back to Refined", async () => {
    let ctx!: ReturnType<typeof fake>;
    ctx = fake(() => {
      // What the engine writes while it runs the command.
      ctx.emit("engine.notice", {
        level: "info",
        code: "adapter.released",
        text: "The launch checks for claude-cli passed.",
      });
      ctx.emit("engine.notice", {
        level: "warn",
        code: "setup.failed",
        text: "DIPO-7 was not started: setup failed (install (bun install --frozen-lockfile) failed: exit 1: mktemp: mkstemp failed: Operation not permitted). The worktree was removed and the story stays Ready.",
      });
      ctx.emit("story.state", {
        story: "DIPO-8",
        key: KEY_2,
        from: "Ready",
        to: "Refined",
        view: {},
        detail: ["ready DIPO-8 failed R15: unknown is open"],
      });
      return result(
        [],
        [
          { story: "DIPO-7", key: KEY, reason: "pickupCheckFailed" },
          { story: "DIPO-8", key: KEY_2, reason: "pickupCheckFailed" },
        ],
      );
    }, IN_OFFICE);
    expect(await main(["run"], ctx.deps)).toBe(1);
    expect(ctx.subscribed).toEqual([`office:${OFFICE}`]);
    expect(ctx.listeners.size).toBe(0);
    expect(ctx.out).toEqual([
      "skipped DIPO-7: it failed its pickup check (it goes back to Refined) or its setup, launch checks or worker start (it stays Ready)",
      "  DIPO-7 was not started: setup failed (install (bun install --frozen-lockfile) failed: exit 1: mktemp: mkstemp failed: Operation not permitted). The worktree was removed and the story stays Ready.",
      "skipped DIPO-8: it failed its pickup check (it goes back to Refined) or its setup, launch checks or worker start (it stays Ready)",
      "  ready DIPO-8 failed R15: unknown is open",
    ]);
  });

  it("prints the skip alone when no explanation arrives in time", async () => {
    const ctx = fake(
      () => result([], [{ story: "DIPO-7", key: KEY, reason: "collision" }]),
      IN_OFFICE,
    );
    const running = main(["run"], ctx.deps);
    for (let i = 0; i < 20 && ctx.sent.length === 0; i++) await Bun.sleep(0);
    await Bun.sleep(0);
    (ctx.deps.clock as ManualClock).advance(EXPLAIN_WAIT_MS);
    expect(await running).toBe(1);
    expect(ctx.out).toEqual(["skipped DIPO-7: its branch or worktree path is taken"]);
  });
});

describe("dipo run", () => {
  it("starts the engine's pick with from, and prints started and skipped stories with reasons", async () => {
    const ctx = fake(
      () =>
        result(
          [{ story: "DIPO-7", key: KEY, run: RUN }],
          [{ story: "DIPO-8", key: KEY_2, reason: "dependency" }],
        ),
      IN_OFFICE,
    );
    expect(await main(["run"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "work.run", args: { from: "/work/app" }, office: OFFICE }]);
    expect(ctx.out).toEqual([
      `started DIPO-7 (run ${RUN})`,
      "skipped DIPO-8: a dependency is not Done",
    ]);
    expect(ctx.err).toEqual([]);
  });

  it("names stories, upper-cases ids, keeps keys, and sends no from with --office", async () => {
    const ctx = fake(() => result([], [{ story: "DIPO-7", key: KEY, reason: "capacity" }]));
    expect(await main(["run", "dipo-7", KEY, "--office", OTHER], ctx.deps)).toBe(1);
    expect(ctx.sent).toEqual([
      { name: "work.run", args: { stories: ["DIPO-7", KEY] }, office: OTHER },
    ]);
    expect(ctx.out).toEqual(["skipped DIPO-7: the office already runs a story"]);
  });

  it("explains a plan-limit skip in words, not as a full office (DIPO-92)", async () => {
    const ctx = fake(
      () => result([], [{ story: "DIPO-7", key: KEY, reason: "planLimit" }]),
      IN_OFFICE,
    );
    expect(await main(["run"], ctx.deps)).toBe(1);
    expect(ctx.out).toEqual([
      "skipped DIPO-7: a plan limit, or a plan-limit warning, holds new runs on its model until the reset (it stays Ready)",
    ]);
  });

  it("says so when nothing was Ready, and prints an unknown reason as it is", async () => {
    const empty = fake(() => result([]), IN_OFFICE);
    expect(await main(["run"], empty.deps)).toBe(1);
    expect(empty.out).toEqual(["no Ready story to start"]);
    const later = fake(
      () => result([], [{ story: "DIPO-7", key: KEY, reason: "tooSoon" }]),
      IN_OFFICE,
    );
    expect(await main(["run"], later.deps)).toBe(1);
    expect(later.out).toEqual(["skipped DIPO-7: tooSoon"]);
  });

  it("prints a refusal and exits 1", async () => {
    const ctx = fake(
      () => ({
        ok: false,
        error: {
          code: "git.fetchFailed",
          message: "Fetching origin failed (offline).",
          retryable: true,
        },
      }),
      IN_OFFICE,
    );
    expect(await main(["run"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("git.fetchFailed: Fetching origin failed (offline).");
  });

  it("refuses a malformed id and unknown arguments", async () => {
    for (const args of [
      ["run", "seven!"],
      ["run", "--yes"],
    ]) {
      const ctx = fake(() => result([]), IN_OFFICE);
      expect(await main(args, ctx.deps)).toBe(2);
      expect(ctx.sent).toEqual([]);
    }
  });
});

const LAUNCH = {
  adapter: "claude-cli",
  branch: "DIPO-7/add-a-greeting",
  worktree: "/work/app.worktrees/DIPO-7",
  runDir: "/work/app/.git/dipo/runs/<run-id>",
  cwd: "/work/app.worktrees/DIPO-7",
  argv: [
    "/opt/claude/bin/claude",
    "-p",
    "--verbose",
    "--model",
    "sonnet",
    "--json-schema",
    '{"type":"object"}',
  ],
  model: "sonnet",
  effort: "medium",
  caps: { budgetTokens: 800_000, maxTurns: 120, maxMinutes: 60, loops: 4 },
  envNames: ["DIPO_RUN", "HOME", "PATH"],
  files: [
    { name: "claude-settings.json", content: '{\n  "sandbox": { "enabled": true }\n}\n' },
    { name: "report-schema.json", content: '{\n  "type": "object"\n}\n' },
  ],
  systemFile: { path: "/work/app/.git/dipo/runs/<run-id>/system.md", text: "You implement.\n" },
  taskMessage: "<story>\nDIPO-7 Add a greeting\n</story>\n",
};

describe("dipo run without a daemon (DIPO-187)", () => {
  it("--dry-run prints the not-running line with the start hint and never asks to start the daemon", async () => {
    const modes: string[] = [];
    const ctx = fake(
      () => {
        throw new Error("work.run must not be sent");
      },
      IN_OFFICE,
      () => {
        throw new Error("work.preview must not be sent");
      },
    );
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["run", "--dry-run"], deps)).toBe(1);
    expect(modes).toEqual(["running"]);
    expect(ctx.err).toEqual([
      `dipo: no daemon is running (nothing answers on /state/dipo.sock). ${START_HINT}`,
    ]);
    expect(ctx.out).toEqual([]);
  });

  it("a run without --dry-run still asks for a connection that may start the daemon", async () => {
    const modes: string[] = [];
    const ctx = fake(() => {
      throw new Error("work.run must not be sent");
    }, IN_OFFICE);
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["run"], deps)).toBe(1);
    expect(modes).toEqual(["start"]);
  });
});

describe("dipo run --dry-run", () => {
  it("reads work.preview and prints each part of the launch under its own header", async () => {
    const ctx = fake(
      () => {
        throw new Error("work.run must not be sent");
      },
      IN_OFFICE,
      () => ({
        ok: true,
        result: {
          refusals: [],
          story: { story: "DIPO-7", key: KEY },
          skipped: [{ story: "DIPO-8", key: KEY_2, reason: "capacity" }],
          launch: LAUNCH,
          problem: null,
        },
      }),
    );
    expect(await main(["run", "--dry-run", "dipo-7"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "work.preview", args: { office: OFFICE, stories: ["DIPO-7"] }, office: undefined },
    ]);
    const out = ctx.out.join("\n");
    for (const header of [
      "== Office checks ==",
      "== Story ==",
      "== Branch and worktree it would create ==",
      "== Worker launch (claude-cli) ==",
      "== Run directory file claude-settings.json (permissions and sandbox settings) ==",
      "== Run directory file report-schema.json ==",
      "== System file /work/app/.git/dipo/runs/<run-id>/system.md ==",
      "== Task message (the first user message, on stdin) ==",
    ]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("would start DIPO-7");
    expect(out).toContain("skipped DIPO-8: the office already runs a story");
    expect(out).toContain("branch:        DIPO-7/add-a-greeting");
    expect(out).toContain("worktree:      /work/app.worktrees/DIPO-7 (locked)");
    expect(out).toContain("program:           /opt/claude/bin/claude");
    expect(out).toContain("caps:              800,000 tokens, 120 turns, 60 minutes, 4 loops");
    expect(out).toContain("  --model sonnet");
    expect(out).toContain("  --json-schema <the JSON of report-schema.json below, on one line>");
    expect(out).toContain(
      "environment (names only, values are not shown):\n  DIPO_RUN\n  HOME\n  PATH",
    );
    expect(out).toContain('"sandbox": { "enabled": true }');
    expect(out).toContain("DIPO-7 Add a greeting");
    expect(ctx.err).toEqual([]);
  });

  it("prints the refusals and why no launch was planned, and exits 1", async () => {
    const ctx = fake(
      () => {
        throw new Error("work.run must not be sent");
      },
      IN_OFFICE,
      () => ({
        ok: true,
        result: {
          refusals: [{ check: "adapter", message: "New runs on claude-cli are held." }],
          story: { story: "DIPO-7", key: KEY },
          skipped: [],
          launch: null,
          problem: "DIPO-7 was not started: the launch plan refused the path /a(b)",
        },
      }),
    );
    expect(await main(["run", "--dry-run"], ctx.deps)).toBe(1);
    const out = ctx.out.join("\n");
    expect(out).toContain("refused (adapter): New runs on claude-cli are held.");
    expect(out).toContain(
      "no launch: DIPO-7 was not started: the launch plan refused the path /a(b)",
    );
    expect(out).not.toContain("== Worker launch");
  });

  it("prints the slots refusal with each holder and not would start", async () => {
    const message =
      "every port slot from 1 to 1 is taken by another worktree: slot 1: office off_a, story DIPO-3, worktree /work/app.worktrees/DIPO-3";
    const ctx = fake(
      () => {
        throw new Error("work.run must not be sent");
      },
      IN_OFFICE,
      () => ({
        ok: true,
        result: {
          refusals: [{ check: "slots", message }],
          story: null,
          skipped: [],
          launch: null,
          problem: null,
        },
      }),
    );
    expect(await main(["run", "--dry-run"], ctx.deps)).toBe(1);
    const out = ctx.out.join("\n");
    expect(out).toContain(`refused (slots): ${message}`);
    expect(out).toContain("no story would start");
    expect(out).not.toContain("would start DIPO");
  });
});
