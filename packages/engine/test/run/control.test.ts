// Run control (DIPO-50), fast and local: a migrated state database with one claimed story run, the
// real DIPO-45 ingestion of committed Claude recordings with run control as its hooks, scripted
// worker events, a fake park writer for the story branch (the real one runs in park.ci.test.ts on
// real git) and a steering fake. `work.stop` runs through the executor; its stop sequence goes to a
// FakeProcess through the worker host's own `Steering`. An intent the database refuses sends nothing
// (DIPO-119).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  StoryId,
  type RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";
import { FakeProcess, readRecording } from "@dipsaus-orchestrator/testkit";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { GitError } from "../../src/git/runner";
import { Steering } from "../../src/host/steering";
import type { ProcessInfo } from "../../src/platform/process";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  CAP_TICK_MS,
  findRun,
  hostSocketSteering,
  insertRun,
  type ParkBranchRequest,
  RunControl,
  runIntents,
  type RunSteering,
  STORY_NOT_RUNNING,
} from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { encode, STOP_MESSAGE } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { Caps, HostOp, ParseState, WorkerEvent } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { countRows } from "../commands/helpers";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  target,
} from "../ingest/helpers";
import { watchRejections } from "../platform/rejections";
import { RECORDINGS_DIR } from "../workers/replay";
import { SCRIPTS } from "../workers/scripts";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly writes: ParkBranchRequest[];
  readonly sent: HostOp[][];
  /** Story keys read again after a park (DIPO-56). */
  readonly refreshed: string[];
  readonly work: WorkRef;
  writer: "ok" | "tampered" | "fails";
  steer: RunSteering["send"] | null;
  ingestor: Ingestor | null;
  /** What run control logged through its `warn` dependency. */
  readonly warnings: { message: string; fields: Readonly<Record<string, unknown>> }[];
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "run-control-"));
  const f = await ingestFixture(dir);
  const writes: ParkBranchRequest[] = [];
  const sent: HostOp[][] = [];
  const refreshed: string[] = [];
  const world = {
    dir,
    f,
    writes,
    sent,
    refreshed,
    writer: "ok",
    steer: null,
    ingestor: null,
    warnings: [],
  } as unknown as World;
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
    writer: {
      write: async (_office, request): Promise<BranchPark> => {
        writes.push(request);
        if (world.writer === "tampered") {
          throw new GitError(
            "git.worktreeTampered",
            `The git links of ${request.worktree} changed since dipo claimed it (${request.worktree}/.git); dipo runs no git in that worktree.`,
          );
        }
        if (world.writer === "fails") throw new Error("the Backlog CLI exited 1");
        return {
          commit: "c".repeat(40),
          lastGoodCommit: "a".repeat(40),
          from: "In Progress",
          pushed: true,
          pushError: null,
        };
      },
    },
    steering: {
      send: async (office, runId, ops) => {
        sent.push([...ops]);
        return world.steer === null ? { ok: true } : world.steer(office, runId, ops);
      },
    },
    encode,
    refreshStory: async (_office, key) => {
      refreshed.push(key);
    },
    warn: (message, fields) => world.warnings.push({ message, fields }),
  });
  (world as { control: RunControl }).control = control;
  w = world;
  // The claimed story run of the fixture's work.
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
  const work = world.work;
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key: work.key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: ROOMY.budgetTokens,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
    insertClaim(office, {
      runId: run,
      key: work.key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
  });
});

afterEach(() => {
  w.ingestor?.close();
  w.control.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

function track(caps: Caps = ROOMY): void {
  w.control.track(w.f.office.officeId, {
    runId: w.f.run,
    work: w.work,
    caps,
    startedAt: w.f.t.clock.now(),
  });
}

/** Ingests a committed recording's event file with run control as the ingestion hooks. */
async function ingestRecording(name: string): Promise<void> {
  const recording = readRecording(join(RECORDINGS_DIR, name));
  appendLines(w.f.eventFile, hostLines(recording));
  const ingestor = new Ingestor({
    office: w.f.office,
    clock: w.f.t.clock,
    pricing: null,
    hooks: w.control.hooks,
  });
  w.ingestor = ingestor;
  ingestor.track(
    target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
  );
  await w.control.idle();
}

function parks(): {
  reason: string;
  from_state: string;
  detail: string;
  last_good_commit: string;
}[] {
  return w.f.office.all(
    "select reason, from_state, detail, last_good_commit from parks where office_id = $office_id",
  );
}

function parkedEvents(): Record<string, unknown>[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "story.parked")
    .map((event) => event.data as Record<string, unknown>);
}

describe("caps", () => {
  it("parks budget-exceeded at 100% of budgetTokens (budget-engine-cap) and never raises it", async () => {
    const recording = readRecording(join(RECORDINGS_DIR, "budget-engine-cap"));
    const budget = recording.meta.testConfig?.["budgetTokens"] as number;
    track({ ...ROOMY, budgetTokens: budget });
    await ingestRecording("budget-engine-cap");

    const [park] = parks();
    expect(park?.reason).toBe("budget-exceeded");
    expect(park?.detail).toContain("token budget reached");
    expect(park?.detail).toContain(`of ${budget.toLocaleString("en-US")} budget tokens`);
    // The detail names the total at the crossing event, not the end of the pass.
    const used = Number(/reached: ([\d,]+) of/.exec(park?.detail ?? "")?.[1]?.replaceAll(",", ""));
    const end = w.f.office.get<{ used: number }>(
      `select sum(input + output + cache_create) as used from usage_totals
       where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    );
    expect(used).toBeGreaterThanOrEqual(budget);
    expect(used).toBeLessThan(end?.used ?? 0);
    expect(park?.from_state).toBe("In Progress");
    expect(park?.last_good_commit).toBe("a".repeat(40));
    // The cap intent was stored, then the stop sequence sent.
    const intents = runIntents(w.f.office, w.f.run);
    expect(intents.map((i) => [i.kind, i.state])).toEqual([["cap", "resolved"]]);
    expect(intents[0]?.outcome).toBe("capped");
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    const run = findRun(w.f.office, w.f.run);
    expect(run?.endKind).toBe("capped");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.budgetLimit).toBe(ROOMY.budgetTokens);
    expect(w.writes.map((r) => [r.reason, r.story, r.branch])).toEqual([
      ["budget-exceeded", "DIPO-1", "DIPO-1/add-a-greeting"],
    ]);
    // story.state to Parked, then story.parked with no action the engine does not implement.
    const types = loggedEvents(w.f.office).map((event) => event.type);
    expect(types.indexOf("story.state")).toBeLessThan(types.indexOf("story.parked"));
    const [parked] = parkedEvents();
    expect(parked?.["reason"]).toBe("budget-exceeded");
    expect(parked?.["from"]).toBe("In Progress");
    expect(parked?.["lastGoodCommit"]).toBe("a".repeat(40));
    expect(parked?.["actions"]).toEqual([]);
    expect((parked?.["work"] as WorkRef | undefined)?.run).toBe(w.f.run);
  });

  it("parks budget-exceeded naming the turn cap when the CLI backstop fires (max-turns), and the later done turn never overrides it", async () => {
    track();
    await ingestRecording("max-turns");
    expect(parks().map((p) => p.reason)).toEqual(["budget-exceeded"]);
    expect(parks()[0]?.detail).toBe("turn cap (--max-turns) after 2 turns");
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["cap"]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("capped");
    expect(w.writes).toHaveLength(1);
  });

  it("stops at the first turn that ends at the backstop, even with a done turn in the same pass", async () => {
    track();
    const capped: WorkerEvent = {
      t: "turn",
      report: null,
      totals: {},
      numTurns: 1,
      terminal: "max_turns",
      capped: "turn cap (--max-turns) after 1 turns",
    };
    const done = SCRIPTS["done"]?.at(-1) as WorkerEvent;
    w.control.onWorkerEvents(w.f.run, [capped, done]);
    w.control.onWorkerEvents(w.f.run, [done]);
    await w.control.idle();
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["budget-exceeded", "turn cap (--max-turns) after 1 turns"],
    ]);
    expect(w.sent).toHaveLength(1);
  });

  it("parks at the engine's summed turn cap", async () => {
    track({ ...ROOMY, maxTurns: 2 });
    await ingestRecording("success-single");
    expect(parks().map((p) => p.reason)).toEqual(["budget-exceeded"]);
    expect(parks()[0]?.detail).toMatch(/^turn cap reached: \d+ of 2 turns$/);
  });

  it("fires the time cap on the next tick with no events after the start", async () => {
    track({ ...ROOMY, maxMinutes: 30 });
    w.f.t.clock.advance(29 * CAP_TICK_MS);
    await w.control.idle();
    expect(parks()).toEqual([]);
    // Wall-clock time: a jump such as a machine waking from sleep counts in full.
    w.f.t.clock.advance(5 * CAP_TICK_MS);
    await w.control.idle();
    expect(parks().map((p) => p.reason)).toEqual(["budget-exceeded"]);
    expect(parks()[0]?.detail).toBe("time cap reached: 30 of 30 minutes since the worker started");
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["cap", "sent"],
    ]);
  });
});

describe("caps as of each event in one pass", () => {
  const MODEL = "claude-haiku-5-5";
  const usage = (n: number, input: number): WorkerEvent => ({
    t: "usage",
    messageId: `msg-${n}`,
    model: MODEL,
    input,
    output: 0,
    cacheCreate: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
  });
  const blocked = (input: number): WorkerEvent => ({
    t: "turn",
    report: {
      status: "blocked",
      criteria: [],
      summary: "Blocked.",
      commitSubject: "nothing",
      question: "Which greeting?",
    },
    totals: { [MODEL]: { input, output: 0, cacheCreate: 0, cacheRead: 0 } },
    numTurns: 1,
    terminal: "completed",
  });
  /** An adapter whose host lines are worker events as JSON, so one pass holds exactly these. */
  const passThrough: IngestAdapter = {
    interpret: (line, state) =>
      line.ch === "stdout"
        ? { events: [JSON.parse(line.data) as WorkerEvent], state }
        : { events: [], state },
  };
  function onePass(events: readonly WorkerEvent[]): Promise<void> {
    appendLines(
      w.f.eventFile,
      events.map((event, i) => ({ t: i, ch: "stdout", data: JSON.stringify(event) })),
    );
    const ingestor = new Ingestor({
      office: w.f.office,
      clock: w.f.t.clock,
      pricing: null,
      hooks: w.control.hooks,
    });
    w.ingestor = ingestor;
    ingestor.track(target(w.f, passThrough, {}));
    return w.control.idle();
  }

  it("parks at the crossing event with its total, before a later blocked report", async () => {
    track({ ...ROOMY, budgetTokens: 1_500 });
    await onePass([usage(1, 1_000), usage(2, 1_000), usage(3, 1_000), blocked(3_000)]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      [
        "budget-exceeded",
        "token budget reached: 2,000 of 1,500 budget tokens (input, output and cache creation)",
      ],
    ]);
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["cap"]);
  });

  it("lets a blocked report that came before the crossing win", async () => {
    track({ ...ROOMY, budgetTokens: 1_500 });
    await onePass([usage(1, 500), blocked(500), usage(2, 1_000), usage(3, 1_000)]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["ambiguous-spec", "Which greeting?"],
    ]);
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["park"]);
  });
});

describe("reports", () => {
  it("parks ambiguous-spec with the question as detail (worker-park-ambiguous)", async () => {
    track();
    await ingestRecording("worker-park-ambiguous");
    const [park] = parks();
    expect(park?.reason).toBe("ambiguous-spec");
    const question = parkedEvents()[0]?.["detail"];
    expect(typeof question).toBe("string");
    expect(park?.detail).toBe(question as string);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.outcome])).toEqual([
      ["park", "blocked"],
    ]);
  });

  it("parks needs-permission with the tool and action, keeping worktree, branch, claim and session", async () => {
    track();
    w.f.office.immediate(() =>
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', 0)`,
        { agent: w.f.agent, run: w.f.run },
      ),
    );
    w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-permission"] as WorkerEvent[]);
    await w.control.idle();
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["needs-permission", "Bash: bun add left-pad"],
    ]);
    const claim = w.f.office.get<{ released_at: number | null }>(
      "select released_at from claims where office_id = $office_id and run_id = $run",
      { run: w.f.run },
    );
    expect(claim?.released_at).toBeNull();
    const agent = w.f.office.get<{ session_id: string; end_reason: string }>(
      "select session_id, end_reason from agents where office_id = $office_id and agent_id = $agent",
      { agent: w.f.agent },
    );
    expect(agent).toEqual({ session_id: "session-1", end_reason: "blocked" });
    expect(w.writes[0]?.worktree).toBe(join(w.dir, "trees", "DIPO-1"));
  });
});

describe("a tampered worktree", () => {
  it("parks scope-violation when the park commit is refused with git.worktreeTampered", async () => {
    track();
    w.writer = "tampered";
    w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-question"] as WorkerEvent[]);
    await w.control.idle();
    const [park] = parks();
    expect(park?.reason).toBe("scope-violation");
    expect(park?.detail).toContain("dipo runs no git in that worktree");
    expect(park?.detail).toContain("parking it as ambiguous-spec");
    // One write attempt; nothing else ran in the worktree.
    expect(w.writes).toHaveLength(1);
    const notices = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => (event.data as { code: string }).code);
    expect(notices).toEqual(["park.notWritten"]);
  });

  it("still records a park whose branch write failed, with a notice", async () => {
    track();
    w.writer = "fails";
    w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-question"] as WorkerEvent[]);
    await w.control.idle();
    expect(parks().map((p) => p.reason)).toEqual(["ambiguous-spec"]);
    expect(parks()[0]?.last_good_commit).toBeNull();
  });
});

let requests = 0;
function stopCommand(story: string, note?: string): Promise<CommandReply> {
  requests += 1;
  const registry = buildRegistry([w.control.feature]);
  return executeCommand(
    {
      registry,
      offices: stateOfficeDirectory(w.f.t.state),
      clock: w.f.t.clock,
      ids: w.f.t.ids,
      softwareRequests: new MemoryRequestTable(w.f.t.clock),
    },
    {
      requestId: RequestId.parse(
        `01J9ZK5Q8W3V4X6Y7Z${(90_000 + requests).toString().padStart(8, "0")}`,
      ),
      name: "work.stop",
      args: { story, ...(note === undefined ? {} : { note }) },
      origin: "cli",
      confirmed: true,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

describe("work.stop", () => {
  it("is registered with confirm: true, as commands.describe shows it", () => {
    const stop = buildRegistry([w.control.feature])
      .commandDefinitions()
      .find((definition) => definition.name === "work.stop");
    expect(stop?.confirm).toBe(true);
  });

  it("records the stop intent, sends the stop sequence the fake process sees, and parks stopped", async () => {
    track();
    const recording = readRecording(join(RECORDINGS_DIR, "success-single"));
    const child = new FakeProcess({ lines: recording.lines, clock: w.f.t.clock, stdin: "pipe" });
    const steering = new Steering(child, w.f.t.clock);
    let intentBeforeSend: string | undefined;
    w.steer = async (_office, runId, ops) => {
      intentBeforeSend = runIntents(w.f.office, runId as RunId)[0]?.state;
      for (const op of ops) steering.apply(op);
      return { ok: true };
    };
    const reply = await stopCommand("DIPO-1", "Wrong approach; I will rewrite the story.");
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    expect(reply.result).toEqual({ run: w.f.run });
    expect(intentBeforeSend).toBe("pending");

    // The fake process got the now-priority stop message and its stdin closed; SIGTERM at 10 s,
    // SIGKILL at 30 s.
    expect(child.stdinWrites.map((line) => JSON.parse(line) as { priority?: string })).toEqual([
      expect.objectContaining({ priority: "now" }),
    ]);
    expect(child.stdinWrites[0]).toContain(STOP_MESSAGE.slice(0, 20));
    expect(steering.stdinOpen).toBe(false);
    w.f.t.clock.advance(10_000);
    expect(child.signals).toEqual(["SIGTERM"]);

    expect(parks().map((p) => [p.reason, p.from_state, p.detail])).toEqual([
      ["stopped", "In Progress", "Wrong approach; I will rewrite the story."],
    ]);
    const run = findRun(w.f.office, w.f.run);
    expect(run?.endKind).toBe("stopped");
    expect(run?.endedAt).not.toBeNull();
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    // Branch and worktree are kept: the claim stays live.
    expect(countRows(w.f.office, "claims")).toBe(1);
    const claim = w.f.office.get<{ released_at: number | null }>(
      "select released_at from claims where office_id = $office_id",
    );
    expect(claim?.released_at).toBeNull();
  });

  it("fails story.notRunning for a story with no active run, and after the stop", async () => {
    w.f.office.immediate(() =>
      w.f.office.run(
        "update runs set ended_at = 1, end_kind = 'done' where office_id = $office_id",
      ),
    );
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe(STORY_NOT_RUNNING);
    expect(parks()).toEqual([]);
  });

  it("parks stopped even when the host cannot be reached, with a notice", async () => {
    w.steer = async () => ({ ok: false, reason: "the worker host socket is unreachable" });
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(true);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["stopped", "Stopped by the maintainer."],
    ]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "failed"],
    ]);
    const codes = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => (event.data as { code: string }).code);
    expect(codes).toEqual(["run.stopNotSent"]);
  });
});

/** The codes of the notices written so far, in order. */
function noticeCodes(): string[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => (event.data as { code: string }).code);
}

describe("work.stop on a follow-only host (DIPO-93)", () => {
  const START = 1_767_225_600_000;
  const signals: [number, string][] = [];

  /** The host row as re-attach leaves a follow-only host: mode follow, its real start time. */
  function followOnly(): void {
    signals.length = 0;
    w.f.office.immediate(() =>
      w.f.office.run(
        `update worker_hosts set mode = 'follow', start_time_ms = $start
          where office_id = $office_id and run_id = $run`,
        { start: START, run: w.f.run },
      ),
    );
  }

  function realSteering(info: Partial<ProcessInfo> | null): void {
    w.steer = hostSocketSteering({
      clock: w.f.t.clock,
      probe: async (pid) =>
        info === null
          ? null
          : {
              pid,
              startTimeMs: START,
              zombie: false,
              command: `/opt/dipo daemon worker-host ${w.f.run}`,
              ...info,
            },
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return true;
      },
    }).send;
  }

  it("sends one SIGTERM to the verified host PID and parks stopped as for any stop (AC #1)", async () => {
    track();
    followOnly();
    realSteering({});
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(true);
    // One signal, to the host PID alone (not a group), and no socket op.
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["stopped", "Stopped by the maintainer."],
    ]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    expect(noticeCodes()).toEqual(["run.stopSignalled"]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("stopped");
  });

  it("never signals a PID it cannot verify; the story still parks stopped with the reason", async () => {
    for (const info of [
      null,
      { startTimeMs: START + 60_000 },
      { command: "/usr/bin/vim notes.txt" },
      { zombie: true },
    ]) {
      track();
      followOnly();
      w.f.office.immediate(() =>
        w.f.office.run(
          "update runs set ended_at = null, end_kind = null where office_id = $office_id",
        ),
      );
      realSteering(info);
      const before = parks().length;
      const reply = await stopCommand("DIPO-1");
      expect(reply.ok).toBe(true);
      expect(signals).toEqual([]);
      expect(parks().length).toBe(before + 1);
      expect(parks().at(-1)?.reason).toBe("stopped");
      expect(runIntents(w.f.office, w.f.run).at(-1)?.state).toBe("failed");
      expect(runIntents(w.f.office, w.f.run).at(-1)?.error).toContain("dipo sent no signal");
      expect(noticeCodes().at(-1)).toBe("run.stopNotSent");
    }
  });

  it("never signals a host an older dipo started, which does not stop its worker on SIGTERM", async () => {
    track();
    followOnly();
    w.f.office.immediate(() =>
      w.f.office.run("update worker_hosts set signal_stop = 0 where office_id = $office_id"),
    );
    realSteering({});
    expect((await stopCommand("DIPO-1")).ok).toBe(true);
    expect(signals).toEqual([]);
    expect(runIntents(w.f.office, w.f.run).at(-1)?.error).toContain("older dipo");
    expect(parks().map((p) => p.reason)).toEqual(["stopped"]);
  });

  it("still refuses ops that are not a stop: a steer, a stdin close", async () => {
    followOnly();
    realSteering({});
    const steering = w.steer;
    if (steering === null) throw new Error("no steering");
    for (const ops of [encode({ kind: "steer", text: "hi" }), [{ closeStdin: true } as const]]) {
      const sent = await steering(w.f.office, w.f.run, ops);
      expect(sent.ok).toBe(false);
      expect(sent.ok ? "" : sent.reason).toContain("follow-only");
    }
    expect(signals).toEqual([]);
  });
});

describe("story views and reconcile (DIPO-56)", () => {
  it("reads the parked story again on its branch right after the park commit", async () => {
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(true);
    expect(w.refreshed).toEqual([w.work.key]);
  });

  it("stopForReconcile sends the stop sequence and ends the run with its notice, parking nothing", async () => {
    const run = findRun(w.f.office, w.f.run);
    if (run === null) throw new Error("no run");
    await w.control.stopForReconcile(w.f.office, run, {
      code: "reconcile.runStopped",
      text: "DIPO-1 is Done in Backlog.md",
    });
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("reconciled");
    // The run ended through endRun (DIPO-49): one outcome row.
    expect(countRows(w.f.office, "run_outcomes")).toBe(1);
    expect(parks()).toEqual([]);
    expect(w.writes).toEqual([]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    const codes = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => (event.data as { code: string }).code);
    expect(codes).toEqual(["reconcile.runStopped"]);
  });

  it("parkForReconcile parks scope-violation without writing on the branch", async () => {
    const run = findRun(w.f.office, w.f.run);
    if (run === null) throw new Error("no run");
    await w.control.parkForReconcile(w.f.office, run, "Changed by hand: the worktree is gone.", {
      code: "reconcile.handChanged",
      text: "DIPO-1 changed by hand",
    });
    expect(w.writes).toEqual([]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["scope-violation", "Changed by hand: the worktree is gone."],
    ]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("reconciled");
    // Nothing is read on a branch that cannot be trusted.
    expect(w.refreshed).toEqual([]);
    const codes = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => (event.data as { code: string }).code);
    expect(codes).toEqual(["reconcile.handChanged", "park.notWritten"]);
  });
});

describe("the In Review commit (DIPO-49) and the story view (DIPO-56)", () => {
  it("reads the story again at its branch tip once verify and commit ended the run at In Review", async () => {
    const refreshed: string[] = [];
    const sent: HostOp[][] = [];
    const control = new RunControl({
      clock: w.f.t.clock,
      offices: { get: () => w.f.office },
      writer: { write: async () => Promise.reject(new Error("no park expected")) },
      steering: {
        send: async (_office, _run, ops) => {
          sent.push([...ops]);
          return { ok: true };
        },
      },
      encode,
      finisher: {
        afterTurn: async () => ({ kind: "ended" }),
        summarize: async () => undefined,
      },
      refreshStory: async (_office, key) => {
        refreshed.push(key);
      },
    });
    try {
      control.track(w.f.office.officeId, {
        runId: w.f.run,
        work: w.work,
        caps: ROOMY,
        startedAt: w.f.t.clock.now(),
      });
      const done = SCRIPTS["done"]?.at(-1) as WorkerEvent;
      control.onWorkerEvents(w.f.run, [done]);
      await control.idle();
      expect(refreshed).toEqual([w.work.key]);
      expect(sent).toEqual([[{ closeStdin: true }]]);
    } finally {
      control.close();
    }
  });
});

describe("reconcile against after-turn work (DIPO-56)", () => {
  it("lets no verify and commit in progress commit once reconcile stopped the run", async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    let claimed: boolean | undefined;
    const summaries: string[] = [];
    const control = new RunControl({
      clock: w.f.t.clock,
      offices: { get: () => w.f.office },
      writer: { write: async () => Promise.reject(new Error("no park expected")) },
      steering: { send: async () => ({ ok: true }) },
      encode,
      finisher: {
        afterTurn: async (ctx) => {
          // Verify runs while reconcile decides; the commit claims the run's end first.
          enter();
          await gate;
          claimed = ctx.claimEnd();
          return claimed ? { kind: "ended" } : { kind: "continue" };
        },
        summarize: async (_office, run) => {
          summaries.push(run.runId);
        },
      },
    });
    try {
      control.track(w.f.office.officeId, {
        runId: w.f.run,
        work: w.work,
        caps: ROOMY,
        startedAt: w.f.t.clock.now(),
      });
      control.onWorkerEvents(w.f.run, [SCRIPTS["done"]?.at(-1) as WorkerEvent]);
      await entered;
      const run = findRun(w.f.office, w.f.run);
      if (run === null) throw new Error("no run");
      const stopped = control.stopForReconcile(w.f.office, run, {
        code: "reconcile.runStopped",
        text: "DIPO-1 is Done in Backlog.md",
      });
      open();
      await stopped;
      await control.idle();
      expect(claimed).toBe(false);
      expect(findRun(w.f.office, w.f.run)?.endKind).toBe("reconciled");
      expect(summaries).toEqual([w.f.run]);
      expect(countRows(w.f.office, "run_outcomes")).toBe(1);
    } finally {
      control.close();
    }
  });
});

describe("an intent's sent mark that fails (DIPO-110)", () => {
  it("logs one error and leaves no unhandled rejection; run control keeps running", async () => {
    track();
    // The database refuses the update that marks the intent sent, after the ops went out.
    w.f.t.state.connection.exec(
      `create trigger sent_mark_fails before update of state on run_intents
       when new.state in ('sent', 'failed')
       begin select raise(abort, 'disk I/O error'); end`,
    );
    const watch = watchRejections();
    const acted = w.control.act(w.f.run, {
      intent: "stop",
      detail: "a plan-limit hold",
      ops: encode({ kind: "stop" }),
    });
    expect(acted).toBe(true);
    await w.control.idle();
    expect(await watch.stop()).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.warnings).toEqual([
      {
        message: "sending a run's decision failed",
        fields: {
          run: w.f.run,
          intent: "stop",
          reason: "disk I/O error",
          errorCode: expect.stringMatching(/^SQLITE_CONSTRAINT/),
        },
      },
    ]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "pending"],
    ]);
    // The decision stands and run control still answers for the run.
    expect(w.control.isTracked(w.f.run)).toBe(true);
    expect(w.control.live(w.f.run)).toBe(false);
    expect(w.control.act(w.f.run, { intent: "stop", detail: "again", ops: [] })).toBe(false);
  });
});

describe("an intent that cannot be stored (DIPO-119)", () => {
  it("sends no op, logs one error and returns false; run control keeps the run", async () => {
    track();
    const timers = w.f.t.clock.pendingTimers;
    expect(timers).toBeGreaterThan(0);
    // The database refuses the intent (0008: an op is stored as an intent before it is sent).
    w.f.t.state.connection.exec(
      `create trigger intent_fails before insert on run_intents
       begin select raise(abort, 'disk I/O error'); end`,
    );
    const watch = watchRejections();
    const acted = w.control.act(w.f.run, {
      intent: "stop",
      detail: "a plan-limit hold",
      ops: encode({ kind: "stop" }),
    });
    expect(acted).toBe(false);
    await w.control.idle();
    expect(await watch.stop()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.warnings).toEqual([
      {
        message: "storing a run's decision failed",
        fields: {
          run: w.f.run,
          intent: "stop",
          reason: "disk I/O error",
          errorCode: expect.stringMatching(/^SQLITE_CONSTRAINT/),
        },
      },
    ]);
    expect(runIntents(w.f.office, w.f.run)).toEqual([]);
    // Nothing was decided: the run is live, its cap tick still runs, and a later decision works.
    expect(w.control.live(w.f.run)).toBe(true);
    expect(w.f.t.clock.pendingTimers).toBe(timers);
    w.f.t.state.connection.exec("drop trigger intent_fails");
    expect(
      w.control.act(w.f.run, { intent: "stop", detail: "again", ops: encode({ kind: "stop" }) }),
    ).toBe(true);
    await w.control.idle();
    expect(w.sent).toHaveLength(1);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    expect(w.warnings).toHaveLength(1);
  });
});
