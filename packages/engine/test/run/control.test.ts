// Run control (DIPO-50), fast and local: a migrated state database with one claimed story run, the
// real DIPO-45 ingestion of committed Claude recordings with run control as its hooks, scripted
// worker events, a fake park writer for the story branch (the real one runs in park.ci.test.ts on
// real git) and a steering fake. `story.park` of a running story runs through the executor; its stop sequence goes to a
// FakeProcess through the worker host's own `Steering`. An intent the database refuses sends nothing
// (DIPO-119).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  RoleId,
  StoryId,
  type RunId,
  type WorkRef,
  storyPark,
} from "@dipsaus-orchestrator/contract";
import { FakeProcess, readRecording } from "@dipsaus-orchestrator/testkit";

import { mirrorStory } from "./park-fixture";
import { executeCommand } from "../../src/commands/execute";
import { CRASH, crashAfterHandler } from "../commands/crash";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { OfficeGit } from "../../src/git/office";
import { GitError } from "../../src/git/runner";
import { gatherHandoff, renderHandoff } from "../../src/prompts/handoff";
import { latestWorkerNotes, WORKER_NOTES_MAX } from "../../src/prompts/notes";
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
  recordGrant,
  RunControl,
  runIntents,
  type RunSteering,
  DAEMON_STOPPED_DETAIL,
  STORY_NOT_RUNNING,
  STREAM_DRIFT_LINES,
} from "../../src/run";
import { openPark, PARK_NOT_WRITTEN, reopenParkedRun } from "../../src/run/park";
import { addStory } from "../../src/stories/keys";
import { encode, STOP_MESSAGE } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type {
  Caps,
  HostLine,
  HostOp,
  ParseState,
  WorkerEvent,
  WorkerReport,
} from "../../src/workers/types";
import { TASK_FIELD_ERROR } from "../../src/backlog/runner";
import { findClaim, insertClaim } from "../../src/worktree/records";
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
  writer: "ok" | "tampered" | "taskField" | "fails" | "noSummary";
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
        if (world.writer === "taskField") {
          throw new GitError(
            TASK_FIELD_ERROR,
            `dipo refuses ${request.story}'s task file: unknown fields.`,
          );
        }
        if (world.writer === "fails") throw new Error("the Backlog CLI exited 1");
        return {
          commit: "c".repeat(40),
          lastGoodCommit: "a".repeat(40),
          from: "In Progress",
          pushed: true,
          pushError: null,
          ...(world.writer === "noSummary"
            ? { summaryError: "appending it failed: the Backlog CLI exited 1" }
            : {}),
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
  // The story as the index read it, so a park reaches the mirror (DIPO-360).
  office.immediate(() => mirrorStory(office, { key, story: "DIPO-1" }));
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
  // The run's start snapshot holds the caps under test: a run counts its own budget (DIPO-143).
  w.f.office.run(
    "update runs set budget_limit = $budget where office_id = $office_id and run_id = $run",
    { budget: caps.budgetTokens, run: w.f.run },
  );
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
  // The origin is Backlog.md's (DIPO-360): each park's `from` as its `story.parked` carried it.
  const events = parkedEvents();
  return w.f.office
    .all<{ reason: string; detail: string; last_good_commit: string }>(
      `select reason, detail, last_good_commit from parks
        where office_id = $office_id order by park_id`,
    )
    .map((row, index) => ({ ...row, from_state: String(events[index]?.["from"]) }));
}

/** True when no `story.parked` carries a cause: a park has a reason and a text detail (0020). */
function noCause(): boolean {
  return parkedEvents().every((event) => !Object.hasOwn(event, "cause"));
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
    expect(run?.budgetLimit).toBe(budget);
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
    // A park has a reason and a text detail, no cause (0020).
    expect(noCause()).toBe(true);
  });

  it("counts a budget grant: the run that parks at its start budget goes on past it (DIPO-143)", async () => {
    const recording = readRecording(join(RECORDINGS_DIR, "budget-engine-cap"));
    const budget = recording.meta.testConfig?.["budgetTokens"] as number;
    track({ ...ROOMY, budgetTokens: budget });
    w.f.office.immediate(() =>
      recordGrant(w.f.office, w.f.run, {
        kind: "budget",
        amount: { tokens: 100_000_000, turns: 0, minutes: 0 },
        grantId: "grt_1",
        note: "more room",
        origin: "maintainer",
        client: null,
        at: w.f.t.clock.now(),
      }),
    );
    await ingestRecording("budget-engine-cap");

    const used = w.f.office.get<{ used: number }>(
      `select sum(input + output + cache_create) as used from usage_totals
       where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    );
    // Past the start budget, within the granted one: no cap fired.
    expect(used?.used ?? 0).toBeGreaterThanOrEqual(budget);
    expect(parks().map((p) => p.reason)).not.toContain("budget-exceeded");
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).not.toContain("cap");
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
    expect(noCause()).toBe(true);
  });

  it("parks a blocked report without a question on its summary, keeping worktree, branch, claim and session", async () => {
    track();
    w.f.office.immediate(() =>
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', 0)`,
        { agent: w.f.agent, run: w.f.run },
      ),
    );
    w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-reason"] as WorkerEvent[]);
    await w.control.idle();
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["ambiguous-spec", "bun add left-pad was denied."],
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
    expect(noCause()).toBe(true);
    expect(park?.detail).toContain("dipo runs no git in that worktree");
    expect(park?.detail).toContain("parking it as ambiguous-spec");
    // One write attempt; nothing else ran in the worktree.
    expect(w.writes).toHaveLength(1);
    const notices = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => (event.data as { code: string }).code);
    expect(notices).toEqual(["park.notWritten"]);
  });

  it("parks scope-violation when the park is refused for task file fields dipo does not know (DIPO-270)", async () => {
    track();
    w.writer = "taskField";
    w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-question"] as WorkerEvent[]);
    await w.control.idle();
    const [park] = parks();
    expect(park?.reason).toBe("scope-violation");
    expect(noCause()).toBe(true);
    expect(park?.detail).toContain("unknown fields");
    expect(park?.detail).toContain("parking it as ambiguous-spec");
    expect(w.writes).toHaveLength(1);
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

/** The detail of a park the tests send without a note of their own. */
const PARKED_NOTE = "Parked by the maintainer.";

let requests = 0;
/** `story.park` of a story with a run, as the planning feature hands it to run control. */
function stopCommand(
  story: string,
  note = PARKED_NOTE,
  retry?: { readonly id: string; readonly crash: boolean },
): Promise<CommandReply> {
  requests += 1;
  const park: FeatureModule = {
    name: "park",
    register: (registry) =>
      registry.addAsyncOfficeCommand({
        definition: storyPark,
        handle: async (ctx, args) => {
          const parked = await w.control.parkByMaintainer(ctx, args);
          const identity = ctx.stories.get(args.story)!;
          return {
            ...parked,
            result: { story: identity.story, key: identity.key, ...parked.result },
          };
        },
      }),
  };
  const registry = buildRegistry([w.control.feature, park]);
  const deps = {
    registry,
    offices: stateOfficeDirectory(w.f.t.state),
    clock: w.f.t.clock,
    ids: w.f.t.ids,
    softwareRequests: new MemoryRequestTable(w.f.t.clock),
  };
  return executeCommand(
    // A crash after the handler's commits and before the requests row (DIPO-168 in DIPO-155).
    retry?.crash === true ? crashAfterHandler(deps, "story.park") : deps,
    {
      requestId: RequestId.parse(
        retry?.id ?? `01J9ZK5Q8W3V4X6Y7Z${(90_000 + requests).toString().padStart(8, "0")}`,
      ),
      name: "story.park",
      args: { story, note },
      origin: "cli",
      confirmed: true,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

describe("story.park of a running story", () => {
  it("registers no work.stop: story.park replaces it (0020)", () => {
    const names = buildRegistry([w.control.feature])
      .commandDefinitions()
      .map((definition) => definition.name);
    expect(names).not.toContain("work.stop");
    expect(names).not.toContain("work.pause");
  });

  it("fails with story.parkNotWritten and records no park when the write to Backlog.md fails, and a retry parks (DIPO-360)", async () => {
    track();
    w.writer = "fails";
    const failed = await stopCommand("DIPO-1", "Not now.");
    expect(failed.ok ? null : failed.error.code).toBe(PARK_NOT_WRITTEN);
    expect(parks()).toEqual([]);
    expect(parkedEvents()).toEqual([]);
    expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
    // The maintainer sends it again once the write works.
    w.writer = "ok";
    const retried = await stopCommand("DIPO-1", "Not now.");
    expect(retried.ok).toBe(true);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([["by-maintainer", "Not now."]]);
    expect(openPark(w.f.office, w.work.key)).toMatchObject({ reason: "by-maintainer" });
  });

  it("records the stop intent, sends the stop sequence the fake process sees, and parks by-maintainer", async () => {
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
    expect(reply.result).toEqual({ story: "DIPO-1", key: w.work.key, run: w.f.run });
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
      ["by-maintainer", "In Progress", "Wrong approach; I will rewrite the story."],
    ]);
    expect(noCause()).toBe(true);
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

  it("sends no second stop and writes no second park when a crash before the requests row makes the retry run the handler again", async () => {
    track();
    const sends: unknown[] = [];
    w.steer = async (_office, _run, ops) => {
      sends.push(ops);
      return { ok: true };
    };
    const id = "01J9ZK5Q8W3V4X6Y7Z00000009";
    const crashed = await stopCommand("DIPO-1", "Not now.", { id, crash: true });
    expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
    expect(parks()).toHaveLength(1);
    const retried = await stopCommand("DIPO-1", "Not now.", { id, crash: false });
    // The run it stopped has ended and parked: the retry finds the park and changes nothing.
    expect(retried.ok ? retried.changed : null).toBe(false);
    expect(sends).toHaveLength(1);
    expect(parks()).toHaveLength(1);
    expect(runIntents(w.f.office, w.f.run).filter((intent) => intent.kind === "stop")).toHaveLength(
      1,
    );
    // One park commit on the branch (and its one push).
    expect(w.writes).toHaveLength(1);
  });

  it("fails story.notRunning for a story whose run is done", async () => {
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

  it("parks even when the host cannot be reached, with a notice", async () => {
    w.steer = async () => ({ ok: false, reason: "the worker host socket is unreachable" });
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(true);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([["by-maintainer", PARKED_NOTE]]);
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

describe("story.park of a run on a follow-only host (DIPO-93)", () => {
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

  it("sends one SIGTERM to the verified host PID and parks as for any stop (AC #1)", async () => {
    track();
    followOnly();
    realSteering({});
    const reply = await stopCommand("DIPO-1");
    expect(reply.ok).toBe(true);
    // One signal, to the host PID alone (not a group), and no socket op.
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([["by-maintainer", PARKED_NOTE]]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    expect(noticeCodes()).toEqual(["run.stopSignalled"]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("stopped");
  });

  it("never signals a PID it cannot verify; the story still parks with the reason", async () => {
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
      expect(parks().at(-1)?.reason).toBe("by-maintainer");
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
    expect(parks().map((p) => p.reason)).toEqual(["by-maintainer"]);
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
      // closeStdin after a report-driven end is an exception to the stored intent (the
      // `intents.ts` header): no intent row.
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
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

describe("a turn problem's intent that cannot be stored (DIPO-123)", () => {
  it("is tried again at the next cap tick and sent once the database accepts it", async () => {
    track();
    w.f.t.state.connection.exec(
      `create trigger intent_fails before insert on run_intents
       begin select raise(abort, 'disk I/O error'); end`,
    );
    const watch = watchRejections();
    const problem = {
      intent: "stop" as const,
      detail: "a turn problem",
      ops: encode({ kind: "stop" }),
      retryAtTick: true,
    };
    expect(w.control.act(w.f.run, problem)).toBe(false);
    // The next tick tries it again; the database still refuses it, so the run stays live.
    w.f.t.clock.advance(CAP_TICK_MS);
    expect(w.warnings).toHaveLength(2);
    expect(w.control.live(w.f.run)).toBe(true);
    expect(w.sent).toEqual([]);
    w.f.t.state.connection.exec("drop trigger intent_fails");
    w.f.t.clock.advance(CAP_TICK_MS);
    await w.control.idle();
    expect(await watch.stop()).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.control.live(w.f.run)).toBe(false);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["stop", "sent"],
    ]);
    expect(w.warnings).toHaveLength(2);
  });

  it("still waits for the next tick after an unflagged act fails too", async () => {
    track();
    w.f.t.state.connection.exec(
      `create trigger intent_fails before insert on run_intents
       begin select raise(abort, 'disk I/O error'); end`,
    );
    const watch = watchRejections();
    expect(
      w.control.act(w.f.run, {
        intent: "reassign",
        detail: "a turn problem",
        ops: encode({ kind: "stop" }),
        retryAtTick: true,
      }),
    ).toBe(false);
    // A plan-limit hold fails while the turn problem's retry waits; the retry is kept.
    expect(
      w.control.act(w.f.run, {
        intent: "pause",
        detail: "a plan-limit hold",
        ops: [{ closeStdin: true }],
      }),
    ).toBe(false);
    w.f.t.state.connection.exec("drop trigger intent_fails");
    w.f.t.clock.advance(CAP_TICK_MS);
    await w.control.idle();
    expect(await watch.stop()).toEqual([]);
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.detail, i.state])).toEqual([
      ["reassign", "a turn problem", "sent"],
    ]);
    expect(w.control.live(w.f.run)).toBe(false);
    // Later ticks send nothing more.
    w.f.t.clock.advance(CAP_TICK_MS * 3);
    await w.control.idle();
    expect(w.sent).toHaveLength(1);
    expect(w.warnings).toHaveLength(2);
  });

  it("is not retried when the act is not a turn problem's", async () => {
    track();
    w.f.t.state.connection.exec(
      `create trigger intent_fails before insert on run_intents
       begin select raise(abort, 'disk I/O error'); end`,
    );
    expect(
      w.control.act(w.f.run, {
        intent: "stop",
        detail: "a plan-limit hold",
        ops: encode({ kind: "stop" }),
      }),
    ).toBe(false);
    w.f.t.state.connection.exec("drop trigger intent_fails");
    w.f.t.clock.advance(CAP_TICK_MS);
    await w.control.idle();
    expect(w.sent).toEqual([]);
    expect(runIntents(w.f.office, w.f.run)).toEqual([]);
    expect(w.control.live(w.f.run)).toBe(true);
  });
});

// ---- a capped done turn the finisher lets continue (DIPO-222) --------------------------------------

const MODEL = "claude-haiku-5-5";
const DONE_REPORT: WorkerReport = {
  status: "done",
  criteria: [],
  summary: "Done.",
  commitSubject: "print a greeting",
};
const turn = (extra: { capped?: string } = {}): WorkerEvent => ({
  t: "turn",
  report: DONE_REPORT,
  totals: {},
  numTurns: 1,
  terminal: extra.capped === undefined ? "success" : "max_turns",
  ...(extra.capped === undefined ? {} : { capped: extra.capped }),
});
const capSteps = () =>
  w.f.office.all<{ value: string }>(
    `select value from run_steps where office_id = $office_id and run_id = $run
        and kind = 'cap'`,
    { run: w.f.run },
  );

/**
 * A control whose finisher answers continue for every turn, as for a run without a worktree; with
 * `throws` its afterTurn throws instead (DIPO-235).
 */
function continuing(throws = false): RunControl {
  const control = new RunControl({
    clock: w.f.t.clock,
    offices: { get: () => w.f.office },
    writer: {
      write: async (): Promise<BranchPark> => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering: {
      send: async (_office, _run, ops) => {
        w.sent.push([...ops]);
        return { ok: true };
      },
    },
    encode,
    finisher: {
      afterTurn: async () => {
        if (throws) throw new Error("verify crashed");
        return { kind: "continue" };
      },
      summarize: async () => {},
    },
    warn: (message, fields) => w.warnings.push({ message, fields }),
  });
  control.track(w.f.office.officeId, {
    runId: w.f.run,
    work: w.work,
    caps: ROOMY,
    startedAt: w.f.t.clock.now(),
  });
  return control;
}

describe("a capped done turn whose finisher throws (DIPO-235)", () => {
  it("ends at the cap: the stop is sent, the story parks budget-exceeded, one warn line", async () => {
    const control = continuing(true);
    try {
      control.onWorkerEvents(w.f.run, [turn({ capped: "turn cap (--max-turns) after 61 turns" })]);
      await control.idle();
      expect(w.sent).toEqual([encode({ kind: "stop" })]);
      expect(parks().map((p) => [p.reason, p.detail])).toEqual([
        ["budget-exceeded", "turn cap (--max-turns) after 61 turns"],
      ]);
      expect(findRun(w.f.office, w.f.run)?.endKind).toBe("capped");
      expect(w.warnings).toEqual([
        {
          message: "verify and commit after a capped turn failed; ending at the cap",
          fields: {
            run: w.f.run,
            cap: "maxTurns",
            detail: "turn cap (--max-turns) after 61 turns",
            reason: "verify crashed",
          },
        },
      ]);
    } finally {
      control.close();
    }
  });

  it("begins no cap ending on a turn that crossed no cap; the turn failure is logged as before", async () => {
    const control = continuing(true);
    try {
      control.onWorkerEvents(w.f.run, [turn()]);
      await control.idle();
      expect(w.sent).toEqual([]);
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
      expect(parks()).toEqual([]);
      expect(w.warnings.map((warning) => warning.message)).toEqual([
        "verify and commit after a turn failed",
      ]);
    } finally {
      control.close();
    }
  });
});

describe("a capped done turn the finisher lets continue (DIPO-222)", () => {
  it("parks budget-exceeded at the CLI turn cap, with no In Review end and no cap step", async () => {
    const control = continuing();
    try {
      control.onWorkerEvents(w.f.run, [turn({ capped: "turn cap (--max-turns) after 61 turns" })]);
      await control.idle();
      expect(parks().map((p) => [p.reason, p.detail])).toEqual([
        ["budget-exceeded", "turn cap (--max-turns) after 61 turns"],
      ]);
      expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["cap"]);
      expect(findRun(w.f.office, w.f.run)?.endKind).toBe("capped");
      expect(capSteps()).toEqual([]);
    } finally {
      control.close();
    }
  });

  // A story run always has a worktree (the runs check). The stub stands in for any RunFinisher that
  // answers continue while no other ending holds the run; with VerifyCommit a story run reaches
  // continue only when another ending holds it, and then the fallback leaves that ending in place.
  it("parks budget-exceeded at the engine turn cap of a story run whose finisher answers continue", async () => {
    w.f.office.immediate(() => {
      w.f.office.run(
        `update runs set max_turns = 1 where office_id = $office_id and run_id = $run`,
        { run: w.f.run },
      );
      w.f.office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
         values ($office_id, $agent, $run, 'developer', $model, 's-1', 0)`,
        { agent: w.f.agent, run: w.f.run, model: MODEL },
      );
      w.f.office.run(
        `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, turns,
           updated_at)
         values ($office_id, $run, $agent, $model, 'developer', 'M', 10, 1, 0)`,
        { agent: w.f.agent, run: w.f.run, model: MODEL },
      );
    });
    const control = continuing();
    try {
      const done = turn();
      control.onEventApplied(w.f.run, done);
      control.onWorkerEvents(w.f.run, [done]);
      await control.idle();
      expect(parks().map((p) => [p.reason, p.detail])).toEqual([
        ["budget-exceeded", "turn cap reached: 1 of 1 turns"],
      ]);
      expect(findRun(w.f.office, w.f.run)?.endKind).toBe("capped");
      expect(capSteps()).toEqual([]);
    } finally {
      control.close();
    }
  });

  it("ends a session run at the cap: the cap intent is stored and the stop sent, no In Review end", async () => {
    w.f.t.state.connection.exec("pragma foreign_keys = off");
    w.f.office.run(
      `update runs set kind = 'session', key = null, story_id = null, branch = null,
         worktree = null where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    );
    const control = continuing();
    try {
      control.onWorkerEvents(w.f.run, [turn({ capped: "turn cap (--max-turns) after 61 turns" })]);
      await control.idle();
      expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["cap"]);
      expect(w.sent).toEqual([encode({ kind: "stop" })]);
      expect(findRun(w.f.office, w.f.run)?.endKind).not.toBe("in-review");
      expect(capSteps()).toEqual([]);
    } finally {
      control.close();
    }
  });
});

const notesWorktree = () => findRun(w.f.office, w.f.run)?.worktree ?? "";
const notesTurn = (notes: string | undefined, input = 10): WorkerEvent => ({
  t: "turn",
  report: {
    status: "done",
    criteria: [{ n: 1, met: true, evidence: "greet.ts" }],
    summary: "Partly done.",
    commitSubject: "add a greeting",
    ...(notes === undefined ? {} : { notes }),
  },
  totals: { "claude-haiku-5-5": { input, output: 0, cacheCreate: 0, cacheRead: 0 } },
  numTurns: 1,
  terminal: "completed",
});

describe("worker notes for the handoff (DIPO-154; 0020 section 6)", () => {
  it("stores the notes of every turn report, replacing that agent's earlier notes, at most 1,500 characters", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [notesTurn("First: the parser is half done.")], "agt-a");
    w.control.onWorkerEvents(
      w.f.run,
      [notesTurn(`Second: wire the usage line.\n${"z".repeat(2_000)}`)],
      "agt-a",
    );
    // A report without notes keeps the earlier ones.
    w.control.onWorkerEvents(w.f.run, [notesTurn(undefined)], "agt-a");
    await w.control.idle();
    const rows = w.f.office.all<{
      agent_id: string;
      run_id: string;
      story_key: string;
      text: string;
    }>(
      `select agent_id, run_id, story_key, text from worker_notes
        where office_id = $office_id and worktree = $worktree`,
      { worktree: notesWorktree() },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: "agt-a", run_id: w.f.run, story_key: w.work.key });
    expect(rows[0]?.text.startsWith("Second: wire the usage line.")).toBe(true);
    expect(rows[0]?.text.length).toBeLessThanOrEqual(WORKER_NOTES_MAX);
    // Another agent of the run (the next session) has its own row.
    w.control.onWorkerEvents(w.f.run, [notesTurn("Third: from the next session.")], "agt-b");
    expect(latestWorkerNotes(w.f.office, notesWorktree())).toMatchObject({
      agent: "agt-b",
      text: "Third: from the next session.",
    });
  });

  it("parks a run mid-turn after an earlier turn reported notes, and the handoff carries them", async () => {
    track({ ...ROOMY, maxMinutes: 30 });
    w.control.onWorkerEvents(w.f.run, [
      notesTurn("Next: finish the greeting test; the parser is done."),
    ]);
    // The time cap fires in the middle of the next turn, which never reports.
    w.f.t.clock.advance(31 * CAP_TICK_MS);
    await w.control.idle();
    expect(parks().map((p) => p.reason)).toEqual(["budget-exceeded"]);
    // The park kept the notes.
    expect(latestWorkerNotes(w.f.office, notesWorktree())?.text).toBe(
      "Next: finish the greeting test; the parser is done.",
    );
    // The next session's handoff block, gathered for the worktree, carries them.
    const git = {
      run: async <T>(fn: (session: { ok: () => Promise<string> }) => Promise<T>) =>
        fn({ ok: async () => "" }),
    } as unknown as OfficeGit;
    const facts = await gatherHandoff({
      git,
      location: { kind: "worktree", workTree: notesWorktree() } as never,
      base: "b".repeat(40),
      office: w.f.office,
      lastReport: null,
      lastVerify: null,
      openFeedback: [],
    });
    expect(renderHandoff(facts)).toContain(
      "Notes from the previous session:\nNext: finish the greeting test; the parser is done.\n</handoff>",
    );
  });

  it("stores no notes for a reviewer's session", async () => {
    w.control.track(w.f.office.officeId, {
      runId: w.f.run,
      work: { ...w.work, role: RoleId.parse("reviewer") },
      caps: ROOMY,
      startedAt: w.f.t.clock.now(),
    });
    w.control.onWorkerEvents(w.f.run, [notesTurn("not a developer's notes")]);
    await w.control.idle();
    expect(latestWorkerNotes(w.f.office, notesWorktree())).toBeNull();
  });
});

describe("a park whose summary block was not written (DIPO-154)", () => {
  it("is still recorded and emitted, with a notice that the summary is missing", async () => {
    w.writer = "noSummary";
    track({ ...ROOMY, maxMinutes: 30 });
    w.f.t.clock.advance(31 * CAP_TICK_MS);
    await w.control.idle();
    expect(parks().map((p) => p.reason)).toEqual(["budget-exceeded"]);
    expect(parkedEvents()).toHaveLength(1);
    // The writer was asked for the block, built from the stored facts as of the park.
    const block = w.writes[0]?.summary?.({ lastGoodCommit: "a".repeat(40), uncommitted: 0 });
    expect(block).toContain("Parked ");
    expect(block).toContain(`- Run: ${w.f.run}`);
    const notices = loggedEvents(w.f.office)
      .filter((event) => event.type === "engine.notice")
      .map((event) => event.data as { code: string; text: string });
    expect(notices.map((n) => n.code)).toContain("park.summaryMissing");
    expect(notices.find((n) => n.code === "park.summaryMissing")?.text).toContain(
      "appending it failed: the Backlog CLI exited 1",
    );
  });
});

/** Ingests `lines` with run control as the ingestion hooks. */
async function ingestLines(lines: readonly HostLine[]): Promise<void> {
  appendLines(w.f.eventFile, lines);
  if (w.ingestor === null) {
    w.ingestor = new Ingestor({
      office: w.f.office,
      clock: w.f.t.clock,
      pricing: null,
      hooks: w.control.hooks,
    });
    w.ingestor.track(
      target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    );
  } else {
    w.ingestor.pass(w.f.run, w.f.agent);
  }
  await w.control.idle();
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("stream drift (DIPO-315)", () => {
  let at = 0;
  const out = (data: unknown): HostLine => ({
    t: (at += 10),
    ch: "stdout",
    data: JSON.stringify(data),
  });
  const init = out({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    model: "claude-haiku-5-5",
    claude_code_version: "2.1.296",
    permissionMode: "default",
    tools: ["Read", "StructuredOutput"],
    apiKeySource: "none",
    cwd: "/work",
  });
  const dropped = (n: number) => out({ type: "brand_new_type", n });

  it("parks worker-failed at the threshold, naming the version and count", async () => {
    track();
    await ingestLines([
      init,
      ...Array.from({ length: STREAM_DRIFT_LINES - 1 }, (_, n) => dropped(n)),
    ]);
    expect(parks()).toEqual([]);
    expect(w.sent).toEqual([]);

    await ingestLines([dropped(100)]);
    const [park] = parks();
    expect(park?.reason).toBe("worker-failed");
    expect(park?.detail).toContain("Claude Code 2.1.296");
    expect(park?.detail).toContain(`${STREAM_DRIFT_LINES} unreadable stream lines`);
    expect(park?.detail).toContain(`the threshold is ${STREAM_DRIFT_LINES}`);
    expect(noCause()).toBe(true);
    // The stop sequence, after its intent.
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["park"]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("worker-failed");
  });

  it("starts the drift count again when the stream-drift park is resumed, and says so", async () => {
    track();
    await ingestLines([init, ...Array.from({ length: STREAM_DRIFT_LINES }, (_, n) => dropped(n))]);
    const [park] = parks();
    expect(park?.reason).toBe("worker-failed");
    expect(park?.detail).toContain("A resume starts the count again from 0.");
    const lines = () =>
      w.f.office.get<{ n: number }>(
        `select coalesce(sum(drift_lines), 0) as n from ingest_cursors
          where office_id = $office_id and run_id = $run`,
        { run: w.f.run },
      )?.n;
    expect(lines()).toBe(STREAM_DRIFT_LINES);
    const stored = w.f.office.get<{ park_id: number; reason: string; detail: string }>(
      "select park_id, reason, detail from parks where office_id = $office_id",
    );
    const run = findRun(w.f.office, w.f.run);
    if (stored === null || run === null) throw new Error("no park or run");
    w.f.office.immediate(() =>
      reopenParkedRun(
        w.f.office,
        { parkId: stored.park_id, reason: stored.reason, detail: stored.detail },
        run,
        "In Progress",
        w.f.t.clock.now(),
      ),
    );
    expect(lines()).toBe(0);
  });

  it("parks at once when a completed turn reports no token usage, before its done report decides", async () => {
    track();
    const report: WorkerReport = {
      status: "done",
      criteria: [{ n: 1, met: true, evidence: "e" }],
      summary: "s",
      commitSubject: "c",
    };
    await ingestLines([
      init,
      out({
        type: "result",
        subtype: "success",
        session_id: "session-1",
        is_error: false,
        num_turns: 2,
        terminal_reason: "completed",
        structured_output: report,
        modelUsage: {},
      }),
    ]);
    const [park] = parks();
    expect(park?.reason).toBe("worker-failed");
    expect(park?.detail).toContain("reports no token usage");
    expect(park?.detail).toContain("Claude Code 2.1.296");
    expect(park?.detail).toContain("0 unreadable stream lines");
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("worker-failed");
  });

  it("parks at once on a result line whose usage cannot be read", async () => {
    track();
    await ingestLines([
      init,
      out({ type: "result", subtype: "success", session_id: "session-1", modelUsage: [1] }),
    ]);
    expect(parks().map((park) => park.reason)).toEqual(["worker-failed"]);
    expect(parks()[0]?.detail).toContain("result failed its schema");
  });

  it("does not park a run whose stream reads cleanly (success-single)", async () => {
    track();
    await ingestRecording("success-single");
    expect(parks()).toEqual([]);
  });
});

describe("stopAll: daemon.stop with stopWorkers (DIPO-315)", () => {
  it("stops every live worker through run control, parks it stopped and waits for its exit", async () => {
    track();
    await ingestRecording("success-single");
    // The recording's exit untracked the run: track it again as a worker that still runs.
    expect(w.control.isTracked(w.f.run)).toBe(false);
    track();
    const done = w.control.stopAll(60_000);
    const box: { result: Awaited<typeof done> | null } = { result: null };
    void done.then((value) => {
      box.result = value;
    });
    await settle();
    await w.control.idle();
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(parks().map((p) => [p.reason, p.detail])).toEqual([
      ["by-maintainer", DAEMON_STOPPED_DETAIL],
    ]);
    // The park commit's push reached the remote: recorded on the claim, as every story-branch push.
    expect(findClaim(w.f.office, w.f.run)?.pushedAt).toBe(
      findRun(w.f.office, w.f.run)?.endedAt ?? -1,
    );
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).toEqual(["stop"]);
    // Still waiting: the worker has not exited.
    w.f.t.clock.advance(1_000);
    await settle();
    expect(box.result).toBeNull();
    // The exit is ingested; the next look sees no worker left.
    w.control.onEnded(w.f.run);
    w.f.t.clock.advance(250);
    await settle();
    await done;
    expect(box.result).toEqual({ stopped: 1, deciding: 0, running: 0 });
  });

  it("counts a worker that has not exited within the wait, and stops nothing twice", async () => {
    track();
    const done = w.control.stopAll(1_000);
    await settle();
    await w.control.idle();
    for (let i = 0; i < 5; i++) {
      w.f.t.clock.advance(250);
      await settle();
    }
    expect(await done).toEqual({ stopped: 1, deciding: 0, running: 1 });
    // A second stopAll finds the run already decided: no second stop, no second park.
    const again = w.control.stopAll(0);
    await settle();
    expect(await again).toEqual({ stopped: 0, deciding: 1, running: 1 });
    expect(w.sent).toEqual([encode({ kind: "stop" })]);
    expect(parks()).toHaveLength(1);
  });

  it("returns at once with nothing to stop", async () => {
    expect(await w.control.stopAll()).toEqual({ stopped: 0, deciding: 0, running: 0 });
    expect(w.sent).toEqual([]);
  });
});
