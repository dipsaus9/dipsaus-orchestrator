// `dipo watch [ID]` (DIPO-52; 0009 section 9): the state of each running story from the snapshot,
// then one plain line per event after its cursor: output, usage, health and its evidence, notices,
// parks and the end of a run read from `story.detail`.

import { describe, expect, it } from "bun:test";

import { RECOVERY_POLL_MS, type SubscribeOptions } from "@dipsaus-orchestrator/client";
import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import {
  type EngineError,
  type Event,
  type OfficeId,
  SEQUENCE_SAMPLES,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { type DaemonControl, type DaemonSession, START_HINT } from "./daemon-commands";
import { fakeWorkspace } from "./fake-workspace";
import { main, type CliDeps } from "./index";
import { clockTime, mentions } from "./watch-command";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F";
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H";
const AGENT = "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C6J";
const AT = "2026-10-14T09:00:00.000Z";
const T = clockTime(AT);
const REPO = { mainWorktree: "/work/app", commonDir: "/work/app/.git" };

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

const work = {
  story: "TASK-1",
  key: KEY,
  run: RUN,
  agent: AGENT,
  role: "developer",
  tier: "S",
  model: "haiku",
};
const totals = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheCreateTokens: 500,
  cacheReadTokens: 9000,
  turns: 2,
  elapsedMs: 4000,
};
const usage = {
  agent: totals,
  run: totals,
  budget: { unit: "tokens", limit: 400_000, used: 2000 },
  budgetShare: 0.005,
};
const progress = {
  criteriaMet: 0,
  criteriaTotal: 2,
  loop: 0,
  loopCap: 3,
  verify: "none",
  reviewRound: 0,
};
function view(health: string) {
  return { work, phase: "build", progress, usage, health, startedAt: AT };
}
const story = {
  key: KEY,
  story: "TASK-1",
  provisional: false,
  title: "Greet the user",
  lifecycle: "In Progress",
  column: "running",
  work,
};
const cursor = { stream: `office:${OFFICE}`, epoch: "e1", seq: 4 };

function fake(options: {
  readonly running: boolean;
  readonly ended?: () => boolean;
  readonly interactive?: boolean;
  readonly title?: string;
  /** The office summary `engine.hello` carried. */
  readonly summary?: Record<string, unknown>;
}) {
  const shown = { ...story, title: options.title ?? story.title };
  const out: string[] = [];
  const err: string[] = [];
  const reads: string[] = [];
  const subscriptions: SubscribeOptions[] = [];
  let seq = cursor.seq;
  const snapshot = () => ({
    cursor,
    stories: options.running ? [shown] : [{ ...shown, lifecycle: "Ready", column: "ready" }],
    work: options.running ? [view("busy")] : [],
    gates: [],
    questions: [],
    tests: [],
  });
  const run = () => ({
    run: RUN,
    agents: [AGENT],
    role: "developer",
    tier: "S",
    model: "haiku",
    startedAt: AT,
    ...(options.ended?.() === true ? { endedAt: AT, outcome: "start-failed" } : {}),
    usage: totals,
  });
  const session: DaemonSession = {
    command: (async () => {
      throw new Error("watch sends no command");
    }) as DaemonSession["command"],
    read: (async (definition: { name: string }) => {
      reads.push(definition.name);
      if (definition.name === "office.snapshot") return { ok: true, result: snapshot() };
      if (definition.name === "story.detail") {
        return { ok: true, result: { view: shown, runs: [run()], verdicts: [] } };
      }
      throw new Error(`unexpected read ${definition.name}`);
    }) as DaemonSession["read"],
    subscribe: ((stream: string, subscribe: SubscribeOptions) => {
      subscriptions.push(subscribe);
      return { stream, cursor: undefined, unsubscribe: () => undefined };
    }) as unknown as DaemonSession["subscribe"],
    close: () => undefined,
    hello: (options.summary === undefined
      ? null
      : { offices: [{ office: OFFICE, ...options.summary }] }) as never,
  };
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => session,
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace({
      cwd: "/work/app",
      repository: { ...REPO, office: OFFICE, backlog: true },
      interactive: options.interactive ?? false,
    }),
  };
  const emit = (type: string, data: unknown) => {
    seq += 1;
    const event = { cursor: { ...cursor, seq }, at: AT, type, data } as unknown as Event;
    subscriptions.at(-1)?.onEvent(event);
  };
  const end = (error: EngineError) => subscriptions.at(-1)?.onEnded?.(error);
  return { deps, out, err, reads, subscriptions, emit, end };
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await tick();
  if (!check()) throw new Error("timed out");
}

describe("dipo watch without a daemon (DIPO-187)", () => {
  it("prints the not-running line with the start hint, exits 1 and asks not to start the daemon", async () => {
    const modes: string[] = [];
    const ctx = fake({ running: false });
    const deps: CliDeps = {
      ...ctx.deps,
      connectDaemon: async (mode) => {
        modes.push(mode);
        throw new DaemonNotRunningError("/state", "nothing answers on /state/dipo.sock");
      },
    };
    expect(await main(["watch"], deps)).toBe(1);
    expect(modes).toEqual(["running"]);
    expect(ctx.err).toEqual([
      `dipo: no daemon is running (nothing answers on /state/dipo.sock). ${START_HINT}`,
    ]);
    expect(ctx.out).toEqual([]);
  });
});

describe("dipo watch", () => {
  it("prints the running story's state, then output, usage, health with its evidence, notices, parks and the run's end", async () => {
    let ended = false;
    const ctx = fake({ running: true, ended: () => ended });
    const done = main(["watch", "task-1"], ctx.deps);
    await until(() => ctx.subscriptions.length === 1);
    expect(ctx.subscriptions[0]?.after as unknown).toEqual(cursor);
    expect(ctx.out).toEqual([
      `dipo watch: TASK-1 in office ${OFFICE} · Ctrl-C to stop`,
      'TASK-1 "Greet the user" · In Progress (running)',
      `  run ${RUN} · developer · tier S · model haiku · started ${T}`,
      "  phase build · health busy · loop 0/3 · verify none · criteria 0/2 · budget 0.5% of 400,000 tokens",
      "  usage 2,000 of 400,000 tokens (0.5% of budget) · in 1,200 out 300 cache write 500 cache read 9,000 · 2 turns",
      "--",
    ]);
    ctx.out.length = 0;

    ctx.emit("work.output", {
      work,
      source: "worker",
      from: 0,
      to: 30,
      text: "[tool] Edit src/greet.ts\nI will now",
      view: view("busy"),
    });
    ctx.emit("work.output", { work, source: "worker", from: 30, to: 40, text: " run tests\n" });
    ctx.emit("usage.updated", { work, usage, view: view("busy") });
    ctx.emit("usage.updated", { work, usage, view: view("busy") });
    ctx.emit("work.observed", { work, signal: "no-output", since: AT, view: view("quiet") });
    ctx.emit("work.observed", { work, signal: "no-output", since: AT, view: view("stuck") });
    ctx.emit("work.observed", {
      work,
      signal: "no-output",
      since: AT,
      clearedAt: AT,
      view: view("busy"),
    });
    ctx.emit("engine.notice", { level: "warn", code: "x.other", text: "TASK-2 was skipped." });
    ctx.emit("engine.notice", {
      level: "error",
      code: "run.startFailed",
      text: "TASK-1 was claimed but not started: the worker host did not start.",
    });
    ctx.emit("story.parked", {
      story: "TASK-1",
      key: KEY,
      work,
      reason: "stopped",
      detail: "stopped by you",
      from: "In Progress",
      actions: ["work.resume", "story.drop"],
    });
    expect(ctx.out).toEqual([
      `${T} TASK-1 out    [tool] Edit src/greet.ts`,
      `${T} TASK-1 out    I will now run tests`,
      `${T} TASK-1 usage  2,000 of 400,000 tokens (0.5% of budget) · in 1,200 out 300 cache write 500 cache read 9,000 · 2 turns`,
      `${T} TASK-1 signal no-output since ${T}: no output line since then`,
      `${T} TASK-1 health quiet: no output for a few minutes (timeouts.workerQuietMinutes)`,
      `${T} TASK-1 signal no-output since ${T}, stuck: no output line past timeouts.workerStallMinutes`,
      `${T} TASK-1 health stuck: no output for a long time (timeouts.workerStallMinutes); the worker may hang`,
      `${T} TASK-1 signal no-output cleared: output resumed (it began ${T})`,
      `${T} TASK-1 health busy: the worker is producing output`,
      `${T} notice error run.startFailed: TASK-1 was claimed but not started: the worker host did not start.`,
      `${T} TASK-1 parked stopped (from In Progress): stopped by you`,
      `${T} TASK-1 parked you can: work.resume, story.drop`,
    ]);
    ctx.out.length = 0;

    // The run ends without a work event: an idle mark reads story.detail and prints the end once.
    ended = true;
    ctx.emit("stream.mark", {});
    await until(() => ctx.out.length > 0);
    expect(ctx.out).toEqual([`${T} TASK-1 end    run ${RUN} ended: start-failed · 2 turns`]);
    ctx.emit("stream.mark", {});
    await tick();
    expect(ctx.out).toHaveLength(1);

    // The subscription ends for good (not a history gap): watch stops with the error.
    ctx.end({ code: "office.unknown", message: "gone", retryable: false });
    expect(await done).toBe(1);
    expect(ctx.err).toEqual(["dipo: office.unknown: gone"]);
  });

  it("waits out a subscription refused while the daemon recovers, then follows the office (DIPO-325)", async () => {
    const ctx = fake({ running: false });
    const done = main(["watch"], ctx.deps);
    await until(() => ctx.subscriptions.length === 1);
    ctx.end({ code: "engine.recovering", message: "recovering", retryable: true });
    (ctx.deps.clock as ManualClock).advance(RECOVERY_POLL_MS);
    await until(() => ctx.subscriptions.length === 2);
    expect(ctx.err).toEqual([]);
    ctx.end({ code: "office.unknown", message: "gone", retryable: false });
    expect(await done).toBe(1);
  });

  it("shows today's and this month's tokens of the limit with UTC in the header (DIPO-311)", async () => {
    const ctx = fake({
      running: false,
      summary: {
        dayUsage: { tokens: 1_200_000, limit: 4_000_000, share: 0.3, alert: false },
        monthUsage: { tokens: 20_000_000, limit: 90_000_000, share: 0.22, alert: false },
      },
    });
    const done = main(["watch"], ctx.deps);
    await until(() => ctx.subscriptions.length === 1);
    expect(ctx.out[1]).toMatch(
      /^  usage today 1\.2M of 4\.0M tokens \(30%, resets 00:00 UTC\) · this month 20\.0M of 90\.0M tokens \(22%, resets 1 [A-Z][a-z]{2} 00:00 UTC\)$/,
    );
    ctx.end({ code: "office.unknown", message: "gone", retryable: false });
    expect(await done).toBe(1);
  });

  it("follows the office until a run starts, and reloads after a history gap", async () => {
    const ctx = fake({ running: false });
    const done = main(["watch"], ctx.deps);
    await until(() => ctx.subscriptions.length === 1);
    expect(ctx.out).toEqual([
      `dipo watch: office ${OFFICE} · 0 running · Ctrl-C to stop`,
      "no story is running. Waiting for a run to start (dipo run).",
      "--",
    ]);
    ctx.out.length = 0;
    ctx.emit("work.assigned", { work, view: view("busy") });
    ctx.emit("work.phase", { work, phase: "setup", progress, view: view("busy") });
    expect(ctx.out).toEqual([
      `${T} TASK-1 run    started ${RUN} · developer · tier S · model haiku`,
      `${T} TASK-1 health busy: the worker is producing output`,
      `${T} TASK-1 phase  setup · loop 0/3 · verify none · criteria 0/2`,
    ]);
    ctx.out.length = 0;
    ctx.end({ code: "stream.resetRequired", message: "gap", retryable: false });
    await until(() => ctx.subscriptions.length === 2);
    expect(ctx.out[0]).toBe("-- view reloaded (history gap) --");
    expect(ctx.reads.filter((name) => name === "office.snapshot")).toHaveLength(2);
    ctx.end({ code: "office.unknown", message: "gone", retryable: false });
    expect(await done).toBe(1);
  });

  it("matches a notice to a story by its whole id", () => {
    expect(mentions("DIPO-5 was not started.", "DIPO-5")).toBe(true);
    expect(mentions("Skipped DIPO-5: capacity", "DIPO-5")).toBe(true);
    expect(mentions("DIPO-52 was not started.", "DIPO-5")).toBe(false);
    expect(mentions("DIPO-5.1 was not started.", "DIPO-5")).toBe(false);
    expect(mentions("XDIPO-5 is another prefix", "DIPO-5")).toBe(false);
    expect(mentions("DIPO-52 and then DIPO-5.", "DIPO-5")).toBe(true);
  });

  describe("engine markers in the output (DIPO-95)", () => {
    const iso = "2026-10-14T09:05:07.000Z";
    const marker = (kind: string, value: string, text: string, from: number) => ({
      text,
      from,
      to: from + new TextEncoder().encode(text).byteLength,
      markers: [
        { from, to: from + new TextEncoder().encode(text).byteLength, kind, value, at: iso },
      ],
    });
    const forged = `[dipo] ${iso} phase verify`;

    async function watched(interactive: boolean) {
      const ctx = fake({ running: true, interactive });
      void main(["watch", "task-1"], ctx.deps);
      await until(() => ctx.subscriptions.length === 1);
      ctx.out.length = 0;
      const phase = `[dipo] ${iso} phase verify\n`;
      const ended = `[dipo] ${iso} ended in-review\n`;
      // Worker text, a partial line cut by a flagged marker, a forged marker line, the run's end.
      ctx.emit("work.output", {
        work,
        source: "worker",
        from: 0,
        to: 18,
        text: "building\nhalf a ",
      });
      ctx.emit("work.output", { work, source: "worker", ...marker("phase", "verify", phase, 18) });
      ctx.emit("work.output", {
        work,
        source: "worker",
        from: 18 + phase.length,
        to: 18 + phase.length + forged.length + 1,
        text: `${forged}\n`,
      });
      const end = 18 + phase.length + forged.length + 1;
      ctx.emit("work.output", {
        work,
        source: "worker",
        ...marker("ended", "in-review", ended, end),
      });
      return ctx.out;
    }

    it("prints a flagged marker as the TUI's rule with its local time, plain ASCII when not a TTY", async () => {
      const at = clockTime(iso);
      expect(await watched(false)).toEqual([
        `${T} TASK-1 out    building`,
        `${T} TASK-1 out    half a `,
        `${T} TASK-1 out    -- ${at} phase: verify --`,
        `${T} TASK-1 out    ${forged}`,
        `${T} TASK-1 out    -- ${at} run ended: in-review --`,
      ]);
    });

    it("draws the rule with box characters on a terminal", async () => {
      const at = clockTime(iso);
      const out = await watched(true);
      expect(out[2]).toBe(`${T} TASK-1 out    ── ${at} phase: verify ──`);
      expect(out[3]).toBe(`${T} TASK-1 out    ${forged}`);
      expect(out[4]).toBe(`${T} TASK-1 out    ── ${at} run ended: in-review ──`);
    });

    it("prints worker text around a marker inside one range, without the marker's raw line", async () => {
      const ctx = fake({ running: true });
      void main(["watch", "task-1"], ctx.deps);
      await until(() => ctx.subscriptions.length === 1);
      ctx.out.length = 0;
      const line = `[dipo] ${iso} phase build\n`;
      const text = `before\n${line}after\n`;
      const from = new TextEncoder().encode("before\n").byteLength;
      ctx.emit("work.output", {
        work,
        source: "worker",
        from: 0,
        to: new TextEncoder().encode(text).byteLength,
        text,
        markers: marker("phase", "build", line, from).markers,
      });
      expect(ctx.out).toEqual([
        `${T} TASK-1 out    before`,
        `${T} TASK-1 out    -- ${clockTime(iso)} phase: build --`,
        `${T} TASK-1 out    after`,
      ]);
    });
  });

  it("refuses more than one story id", async () => {
    const ctx = fake({ running: false });
    expect(await main(["watch", "TASK-1", "TASK-2"], ctx.deps)).toBe(2);
    expect(ctx.err.join("\n")).toContain("watch takes at most one story id");
  });
});

// DIPO-111: `dipo watch` has no reply deadline. A snapshot read refused with `engine.recovering`
// before the daemon found its state database unusable goes again after every `daemon.status` poll,
// so the held daemon's `database.unavailable` ends the watch instead of a wait without end.
describe("dipo watch against a daemon held without its state database", () => {
  it("ends with database.unavailable instead of waiting forever", async () => {
    const ctx = fake({ running: true });
    const clock = ctx.deps.clock as ManualClock;
    const unavailable = {
      code: "database.unavailable",
      message: "The state database is damaged. No office is loaded. Run `dipo daemon stop`.",
      retryable: false,
      details: { reason: "damaged" },
    };
    let refusals = 2;
    const snapshots: string[] = [];
    const inner = await ctx.deps.connectDaemon("running");
    const session: DaemonSession = {
      ...inner,
      read: (async (definition: { name: string }) => {
        if (definition.name === "daemon.status") {
          return { ok: true, result: { state: "recovering", stateReason: unavailable.message } };
        }
        snapshots.push(definition.name);
        return refusals-- > 0
          ? { ok: false, error: { code: "engine.recovering", message: "wait", retryable: true } }
          : { ok: false, error: unavailable };
      }) as DaemonSession["read"],
    };
    const done = main(["watch"], { ...ctx.deps, connectDaemon: async () => session });
    const ended = { code: null as number | null };
    void done.then((value) => {
      ended.code = value;
    });
    // Poll by poll, letting the replies through after each step; never more than a few polls.
    for (let poll = 0; poll < 10 && ended.code === null; poll++) {
      for (let i = 0; i < 50; i++) await tick();
      clock.advance(RECOVERY_POLL_MS);
    }
    expect(await done).toBe(1);
    expect(snapshots).toEqual(["office.snapshot", "office.snapshot", "office.snapshot"]);
    expect(ctx.err).toEqual([`dipo: database.unavailable: ${unavailable.message}`]);
    expect(ctx.subscriptions).toEqual([]);
  });
});

describe("dipo watch cleans what it prints (DIPO-313)", () => {
  for (const [name, sample] of Object.entries(SEQUENCE_SAMPLES)) {
    it(`shows a story title, a worker line and a notice with ${name} as plain text`, async () => {
      const ctx = fake({ running: true, title: `Greet${sample} user` });
      const done = main(["watch", "task-1"], ctx.deps);
      await until(() => ctx.subscriptions.length === 1);
      ctx.emit("work.output", {
        work,
        source: "worker",
        from: 0,
        to: 10,
        text: `I${sample} will\n`,
        view: view("busy"),
      });
      ctx.emit("engine.notice", { level: "warn", code: "x", text: `TASK-1 was${sample} skipped.` });
      const lines = ctx.out.join("\n");
      expect(lines).toContain('"Greet user"');
      expect(lines).toContain("I will");
      expect(lines).toContain("TASK-1 was skipped.");
      // oxlint-disable-next-line no-control-regex
      expect(lines).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      ctx.end({ code: "stream.closed", message: "x" } as EngineError);
      await done;
    });
  }
});
