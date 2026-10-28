// Worker outcomes (DIPO-51), fast and local: one test per 0017 scenario of the story, on the run
// control harness of control.test.ts (a migrated state database with one claimed story run, the
// real DIPO-45 ingestion of committed Claude recordings with run control as its hooks), with
// worker outcomes wired in and the run's next session stubbed. Every run that ends writes its
// `run_outcomes` row through `endRun`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId, type WorkRef } from "@dipsaus-orchestrator/contract";
import {
  type FakeProcess,
  fakeSpawn,
  ManualClock,
  readRecording,
} from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { OFFICE_DEFAULTS } from "../../src/config";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  activeSignals,
  type BranchPark,
  CAP_TICK_MS,
  endRun,
  findRun,
  insertRun,
  intentTag,
  type LiftedPark,
  type NextSessionOutcome,
  type NextSessionRequest,
  PLAN_LIMIT_RESUME_AFTER_MS,
  type PlanLimitPause,
  planLimitPause,
  raiseSignal,
  recordIntent,
  reportFeedbackText,
  resolveIntent,
  RunControl,
  runIntents,
  runOutcome,
  RunOutcomes,
  StartsPaused,
} from "../../src/run";
import {
  LEGACY_PAUSE_DETAIL,
  LEGACY_PAUSE_TAG,
  LEGACY_PLAN_LIMIT_DETAIL,
} from "../../src/run/outcome-restart";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import { claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
  nextSessionOptions,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { AdapterHolds, type LaunchCheckFailure } from "../../src/workers/hold";
import type { Caps, HostOp, ParseState, TurnProblem, WorkerEvent } from "../../src/workers/types";
import { insertClaim, releaseClaim } from "../../src/worktree/records";
import { countRows } from "../commands/helpers";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  target,
} from "../ingest/helpers";
import { context, withInitPlugins } from "../workers/launch-fixtures";
import { RECORDINGS_DIR } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ClaudeParseState) as unknown as {
      events: [];
      state: ParseState;
    },
};

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const CLOSE: HostOp[] = [{ closeStdin: true }, { signal: "SIGTERM", afterMs: 10_000 }];

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly outcomes: RunOutcomes;
  readonly sent: HostOp[][];
  readonly next: NextSessionRequest[];
  readonly holds: { adapter: string; failures: readonly LaunchCheckFailure[] }[];
  /** The office's starts paused for a plan limit (0020), as worker outcomes told it. */
  readonly paused: { office: string; pause: PlanLimitPause }[];
  /** The office's starts paused itself (0020), on a memory adapter hold store. */
  readonly starts: StartsPaused;
  readonly adapterHolds: AdapterHolds;
  /** The parks the starts paused resumed after a lift. */
  readonly lifted: LiftedPark[];
  readonly released: string[];
  readonly work: WorkRef;
  nextOutcome: NextSessionOutcome;
  /** Runs inside the stubbed next session, before it returns. */
  onNext: ((request: NextSessionRequest) => Promise<void> | void) | null;
  holdsWork: boolean;
  ingestor: Ingestor | null;
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "run-outcomes-"));
  const f = await ingestFixture(dir);
  const world = {
    dir,
    f,
    sent: [],
    next: [],
    holds: [],
    paused: [],
    lifted: [],
    released: [],
    nextOutcome: { kind: "started", agent: "agt_next", resumed: true },
    holdsWork: false,
    ingestor: null,
    onNext: null,
  } as unknown as World;
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      world.sent.push([...ops]);
      return { ok: true as const };
    },
  };
  let outcomes: RunOutcomes | null = null;
  const adapterHolds = new AdapterHolds({ clock: f.t.clock, notify: () => undefined });
  const starts = new StartsPaused({
    clock: f.t.clock,
    offices: { get: () => f.office, config: () => OFFICE_DEFAULTS },
    holds: adapterHolds,
    resume: async (_office, park) => {
      world.lifted.push(park);
      return { outcome: "resumed" };
    },
  });
  Object.assign(world, { starts, adapterHolds });
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
    parkedToResume: (office) => starts.resumeLifted(office),
    writer: {
      write: async (): Promise<BranchPark> => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering,
    encode,
    outcomes: () => outcomes ?? undefined,
  });
  outcomes = new RunOutcomes({
    clock: f.t.clock,
    offices: { get: () => f.office },
    steering,
    encode,
    worker: {
      id: "claude-cli",
      result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    },
    ender: () => control,
    resumer: {
      next: async (request) => {
        world.next.push(request);
        await world.onNext?.(request);
        return world.nextOutcome;
      },
    },
    holds: {
      hold: (adapter, failures) => {
        world.holds.push({ adapter, failures });
        return {
          adapter,
          check: failures[0]?.check ?? "",
          detail: failures[0]?.detail ?? "",
          failures,
          since: 0,
        };
      },
    },
    release: async (_office, claim, reason) => {
      world.released.push(reason);
      f.office.immediate(() =>
        releaseClaim(f.office, claim.runId, { at: f.t.clock.now(), reason, keepBranch: true }),
      );
    },
    holdsWork: async () => world.holdsWork,
    caps: () => ROOMY,
    startsPaused: () => ({
      pausePlanLimit: (office, pause) => {
        world.paused.push({ office, pause });
        starts.pausePlanLimit(office, pause);
      },
      state: (office) => starts.state(office),
      resumeLifted: (office) => starts.resumeLifted(office),
    }),
  });
  Object.assign(world, { control, outcomes });
  w = world;
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
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
      key,
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

/** Ingests a committed recording's event file, with run control as the hooks unless `quiet`. */
async function ingestRecording(name: string, quiet = false): Promise<void> {
  appendLines(w.f.eventFile, hostLines(readRecording(join(RECORDINGS_DIR, name))));
  const ingestor = new Ingestor({
    office: w.f.office,
    clock: w.f.t.clock,
    pricing: null,
    ...(quiet ? {} : { hooks: w.control.hooks }),
  });
  w.ingestor = ingestor;
  ingestor.track(
    target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState, {
      budgetLimit: ROOMY.budgetTokens,
    }),
  );
  await w.control.idle();
}

/** An earlier agent of the run that ended for `reason`. */
function earlierAgent(reason: string): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at,
         end_reason)
       values ($office_id, 'agt_earlier', $run, 'developer', 'haiku', 0, 0, $reason)`,
      { run: w.f.run, reason },
    ),
  );
}

/** Records why the fixture's agent ended, as a decision before a stop would have. */
function setEndReason(reason: string): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      "update agents set end_reason = $reason where office_id = $office_id and agent_id = $agent",
      { reason, agent: w.f.agent },
    ),
  );
}

/** A next session that records its agent, as the real resumer does. */
function startedAgent(): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', $at)`,
      { agent: w.f.t.ids.next("agt"), run: w.f.run, at: w.f.t.clock.now() + 1 },
    ),
  );
}

function turnWith(problem: TurnProblem): WorkerEvent {
  return { t: "turn", report: null, totals: {}, numTurns: 1, terminal: "completed", problem };
}

function parks(): [string, string][] {
  return w.f.office
    .all<{ reason: string; detail: string }>(
      "select reason, detail from parks where office_id = $office_id order by park_id",
    )
    .map((row) => [row.reason, row.detail]);
}

function intents(): [string, string, string | null][] {
  return runIntents(w.f.office, w.f.run).map((intent) => [
    intent.kind,
    intentTag(intent.detail),
    intent.outcome,
  ]);
}

function notices(): { code: string; level: string; text: string }[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => event.data as { code: string; level: string; text: string });
}

function endReason(agent: string = w.f.agent): string | null {
  return (
    w.f.office.get<{ end_reason: string | null }>(
      "select end_reason from agents where office_id = $office_id and agent_id = $agent",
      { agent },
    )?.end_reason ?? null
  );
}

/** The run ended once, through `endRun`, with its outcome row. */
function expectEnded(endKind: string, outcome: string): void {
  const run = findRun(w.f.office, w.f.run);
  expect(run?.endKind).toBe(endKind);
  expect(run?.endedAt).not.toBeNull();
  expect(countRows(w.f.office, "run_outcomes")).toBe(1);
  expect(runOutcome(w.f.office, w.f.run)?.outcome).toBe(outcome);
}

function expectActive(): void {
  expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
  expect(countRows(w.f.office, "run_outcomes")).toBe(0);
}

describe("a missing or invalid report (AC #1)", () => {
  it("gets one feedback turn; a worker that exits before it answers is resumed with it (report-invalid)", async () => {
    track();
    await ingestRecording("report-invalid");
    const text = reportFeedbackText("error_max_structured_output_retries");
    expect(w.sent).toEqual([encode({ kind: "steer", text })]);
    expect(text).toContain("report in the schema");
    expect(intents()).toEqual([["steer", "report-feedback", "resumed"]]);
    expect(w.next.map((request) => [request.mode, request.message])).toEqual([["resume", text]]);
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("a second turn without a valid report parks ambiguous-spec (report-invalid-missing)", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [
      turnWith({ kind: "report", detail: "no structured_output" }),
    ]);
    await w.control.idle();
    expect(w.sent).toEqual([
      encode({ kind: "steer", text: reportFeedbackText("no structured_output") }),
    ]);
    await ingestRecording("report-invalid-missing");
    expect(parks()).toEqual([["ambiguous-spec", "no valid report: no structured_output"]]);
    expect(intents()).toEqual([
      ["steer", "report-feedback", "answered"],
      ["park", "no", "blocked"],
    ]);
    expectEnded("no-report", "parked");
    expect(runOutcome(w.f.office, w.f.run)?.parkReasons).toEqual(["ambiguous-spec"]);
  });

  it("counts the feedback from facts, so a restart does not give a second one", async () => {
    w.f.office.immediate(() =>
      recordIntent(w.f.office, w.f.run, "steer", "report-feedback no structured_output", 0),
    );
    track();
    w.control.onWorkerEvents(w.f.run, [
      turnWith({ kind: "report", detail: "no structured_output" }),
    ]);
    await w.control.idle();
    expect(parks().map(([reason]) => reason)).toEqual(["ambiguous-spec"]);
  });

  it("a verify feedback steer (DIPO-49) is not a report feedback", async () => {
    w.f.office.immediate(() => recordIntent(w.f.office, w.f.run, "steer", "verify feedback", 0));
    track();
    w.control.onWorkerEvents(w.f.run, [
      turnWith({ kind: "report", detail: "no structured_output" }),
    ]);
    await w.control.idle();
    expect(parks()).toEqual([]);
    expect(w.sent).toHaveLength(1);
  });
});

describe("a full context (AC #2)", () => {
  it("prompt_too_long closes the worker and starts one new session with a handoff", async () => {
    track();
    await ingestRecording("prompt-too-long");
    expect(w.sent).toEqual([CLOSE]);
    expect(intents()).toEqual([["reassign", "new-session:context-full", "reassigned"]]);
    expect(endReason()).toBe("prompt-too-long");
    expect(w.next.map((request) => request.mode)).toEqual(["handoff"]);
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("a second full context parks budget-exceeded", async () => {
    earlierAgent("prompt-too-long");
    track();
    await ingestRecording("prompt-too-long");
    expect(parks()).toEqual([
      ["budget-exceeded", "prompt_too_long: the context is full again after a handoff"],
    ]);
    expect(w.next).toEqual([]);
    expectEnded("capped", "parked");
  });
});

describe("a crash (AC #3)", () => {
  it("terminated: no intent, usage recovered, the session resumed once", async () => {
    track();
    await ingestRecording("terminated");
    const used = w.f.office.get<{ used: number }>(
      `select sum(input + output + cache_create) as used from usage_totals
        where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    );
    expect(used?.used ?? 0).toBeGreaterThan(0);
    expect(endReason()).toBe("crashed");
    expect(w.next).toHaveLength(1);
    expect(w.next[0]?.mode).toBe("resume");
    expect(w.next[0]?.why).toContain("exit 143");
    expect(w.next[0]?.work.agent).toBe(w.f.agent);
    expect(intents()).toEqual([]);
    expectActive();
  });

  it("crash-truncated resumes once too", async () => {
    track();
    await ingestRecording("crash-truncated");
    expect(w.next[0]?.why).toContain("partial line");
    expect(endReason()).toBe("crashed");
  });

  it("an execution error while the worker waits is a crash (crash-zeroed, decision Q4)", async () => {
    track();
    await ingestRecording("crash-zeroed");
    expect(w.sent).toEqual([CLOSE]);
    expect(intents()).toEqual([["reassign", "new-session:error", "reassigned"]]);
    expect(endReason()).toBe("crashed");
    expect(w.next.map((request) => request.mode)).toEqual(["resume"]);
  });

  it("a second crash parks worker-failed with the last error", async () => {
    earlierAgent("crashed");
    track();
    await ingestRecording("terminated");
    const [park] = parks();
    expect(park?.[0]).toBe("worker-failed");
    expect(park?.[1]).toContain("exit 143");
    expect(park?.[1]).toContain("one resume after a crash was used");
    expect(w.next).toEqual([]);
    expectEnded("crashed", "parked");
  });

  it("a second execution error parks at the turn", async () => {
    earlierAgent("crashed");
    track();
    await ingestRecording("crash-zeroed");
    expect(parks().map(([reason]) => reason)).toEqual(["worker-failed"]);
    expectEnded("crashed", "parked");
  });

  it("a resumed session that crashes again at once parks worker-failed", async () => {
    // The next session's host replays `terminated` too; its exit is ingested while the first
    // exit's decision is still under way.
    w.onNext = (request) => {
      const agent = w.f.t.ids.next("agt");
      const offset = statSync(w.f.eventFile).size;
      recordWorkerHost(
        w.f.office,
        {
          pid: 4243,
          startTimeMs: 1,
          runId: w.f.run,
          agentId: agent,
          socketPath: join(w.dir, "host2.sock"),
          protocolVersion: 1,
          runDir: w.dir,
          eventFile: w.f.eventFile,
        },
        w.f.t.clock,
      );
      w.f.office.immediate(() =>
        w.f.office.run(
          `update worker_hosts set processed_offset = $offset
            where office_id = $office_id and agent_id = $agent`,
          { offset, agent },
        ),
      );
      appendLines(w.f.eventFile, hostLines(readRecording(join(RECORDINGS_DIR, "terminated"))));
      const work = { ...request.work, agent } as WorkRef;
      w.control.track(w.f.office.officeId, {
        runId: w.f.run,
        work,
        caps: request.caps,
        startedAt: request.startedAt,
      });
      w.ingestor?.track({
        ...target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
        agent,
        work,
      });
    };
    track();
    await ingestRecording("terminated");
    expect(w.next).toHaveLength(1);
    expect(parks().map(([reason]) => reason)).toEqual(["worker-failed"]);
    expect(parks()[0]?.[1]).toContain("one resume after a crash was used");
    expectEnded("crashed", "parked");
  });

  it("a next session that does not start parks worker-failed", async () => {
    w.nextOutcome = { kind: "failed", reason: "the worker host did not start: spawn failed" };
    track();
    await ingestRecording("terminated");
    expect(parks()[0]?.[1]).toContain("the next session did not start: the worker host");
    expectEnded("crashed", "parked");
  });
});

describe("a rejected init (AC #4)", () => {
  for (const name of ["init-rejected", "init-rejected-model"]) {
    it(`${name}: stops the worker and parks worker-failed with an engine.notice`, async () => {
      track();
      await ingestRecording(name);
      expect(w.sent[0]).toEqual([
        { closeStdin: true },
        { signal: "SIGTERM" },
        { signal: "SIGKILL", afterMs: 30_000 },
      ]);
      expect(parks().map(([reason]) => reason)).toEqual(["worker-failed"]);
      expect(parks()[0]?.[1]).toContain("the worker failed its start checks");
      expect(intents()).toEqual([["stop", "init-rejected", "initRejected"]]);
      const notice = notices().find((n) => n.code === "run.initRejected");
      expect(notice?.level).toBe("error");
      expect(w.next).toEqual([]);
      expectEnded("init-rejected", "parked");
    });
  }

  it("the ingestion hook alone stops it too", async () => {
    track();
    w.control.hooks.onInitRejected?.(
      w.f.run,
      w.f.agent,
      "apiKeySource is ANTHROPIC_API_KEY, not none",
    );
    await w.control.idle();
    expect(parks()).toEqual([
      [
        "worker-failed",
        "the worker failed its start checks: apiKeySource is ANTHROPIC_API_KEY, not none",
      ],
    ]);
  });
});

describe("a classifier switch (AC #5)", () => {
  it("model-switch: recorded on the run with one notice, never a park", async () => {
    track();
    await ingestRecording("model-switch");
    const switched = notices().filter((n) => n.code === "run.modelSwitched");
    expect(switched).toHaveLength(1);
    expect(switched[0]?.text).toContain("claude-sonnet-4-5");
    expect(parks()).toEqual([]);
    const cursor = w.f.office.get<{ parse_state: string }>(
      "select parse_state from ingest_cursors where office_id = $office_id and agent_id = $agent",
      { agent: w.f.agent },
    );
    const state = JSON.parse(cursor?.parse_state ?? "{}") as ClaudeParseState;
    expect(state.acceptedModels).toEqual(["claude-sonnet-4-5"]);
  });
});

describe("a start failure (AC #6)", () => {
  for (const name of ["start-failed", "start-failed-auth"]) {
    it(`${name}: holds the adapter, releases the claim and keeps the story Ready`, async () => {
      track();
      await ingestRecording(name);
      expect(w.holds.map((hold) => [hold.adapter, hold.failures[0]?.check])).toEqual([
        ["claude-cli", "start-failed"],
      ]);
      expect(w.released).toEqual(["start-failed"]);
      expect(parks()).toEqual([]);
      const notice = notices().find((n) => n.code === "run.startFailed");
      expect(notice?.text).toContain("the story stays Ready");
      expect(intents().map(([kind, tag, outcome]) => [kind, tag, outcome])).toContainEqual([
        "stop",
        "start-failed",
        "startFailed",
      ]);
      expectEnded("start-failed", "start-failed");
    });
  }

  it("on a worktree with work parks worker-failed and keeps worktree, branch and claim", async () => {
    w.holdsWork = true;
    track();
    await ingestRecording("start-failed");
    expect(w.released).toEqual([]);
    expect(parks().map(([reason]) => reason)).toEqual(["worker-failed"]);
    const claim = w.f.office.get<{ released_at: number | null }>(
      "select released_at from claims where office_id = $office_id",
    );
    expect(claim?.released_at).toBeNull();
    expectEnded("start-failed", "parked");
  });

  it("a launch check refused before a resume holds the adapter and parks when work exists", async () => {
    w.holdsWork = true;
    w.nextOutcome = {
      kind: "startFailed",
      hold: {
        adapter: "claude-cli",
        check: "probe",
        detail: "claude is not logged in",
        failures: [{ check: "probe", detail: "claude is not logged in" }],
        since: 0,
      },
    };
    track();
    await ingestRecording("terminated");
    expect(parks()[0]?.[0]).toBe("worker-failed");
    expect(parks()[0]?.[1]).toContain("claude is not logged in");
    expect(w.holds).toEqual([]);
    expectEnded("start-failed", "parked");
  });
});

/** `parks.resume_on_lift` of every park, oldest first. */
function resumeOnLift(): number[] {
  return w.f.office
    .all<{ resume_on_lift: number }>(
      "select resume_on_lift from parks where office_id = $office_id order by park_id",
    )
    .map((row) => row.resume_on_lift);
}

describe("a plan limit (0020)", () => {
  it("plan-limit-rejected: pauses the office's starts and parks worker-failed until the reset", async () => {
    track();
    const now = w.f.t.clock.now();
    await ingestRecording("plan-limit-rejected");
    const reset = new Date(1_791_827_400 * 1000).toISOString();
    expect(w.sent[0]).toEqual(CLOSE);
    expect(w.paused).toEqual([
      {
        office: w.f.office.officeId,
        pause: {
          detail: `plan limit until ${reset}`,
          since: now,
          until: Date.parse(reset) + PLAN_LIMIT_RESUME_AFTER_MS,
        },
      },
    ]);
    expect(parks()).toEqual([["worker-failed", `plan limit until ${reset}`]]);
    expect(resumeOnLift()).toEqual([1]);
    // No hold and no signal: the run ended, its story parked (0020).
    const observed = loggedEvents(w.f.office).filter((event) => event.type === "work.observed");
    expect(observed.map((event) => (event.data as { signal: string }).signal)).not.toContain(
      "plan-limit",
    );
    expect(w.next).toEqual([]);
    expectEnded("plan-limit", "parked");
  });

  it("plan-limit-429: a 429 turn pauses for an hour and parks the same way, without a reset time", async () => {
    track();
    const now = w.f.t.clock.now();
    await ingestRecording("plan-limit-429");
    expect(w.paused.map((entry) => entry.pause)).toEqual([
      { detail: "plan limit (no reset time given)", since: now, until: now + 60 * 60_000 },
    ]);
    expect(parks()).toEqual([["worker-failed", "plan limit (no reset time given)"]]);
    expect(resumeOnLift()).toEqual([1]);
    expectEnded("plan-limit", "parked");
  });

  it("credits_required pauses with no lift time, holds no adapter, and parks", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [{ t: "limit", status: "rejected", creditsRequired: true }]);
    await w.control.idle();
    expect(w.paused.map((entry) => entry.pause.until)).toEqual([null]);
    expect(w.holds).toEqual([]);
    expect(parks()).toEqual([["worker-failed", "plan limit: the plan needs credits"]]);
    expect(resumeOnLift()).toEqual([1]);
  });

  it("an allowed_warning changes nothing: no pause, no park", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [{ t: "limit", status: "allowed_warning" }]);
    await w.control.idle();
    expect(w.paused).toEqual([]);
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("an exit the adapter reads as a plan limit pauses for an hour and parks", async () => {
    await ingestRecording("plan-limit-429", true);
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.paused.map((entry) => entry.pause.detail)).toEqual([
      "plan limit (no reset time given)",
    ]);
    expect(parks()).toEqual([["worker-failed", "plan limit (no reset time given)"]]);
    expect(resumeOnLift()).toEqual([1]);
  });
});

/** Pauses the office's starts for a plan limit, as another session's limit would. */
function pauseForLimit(): string {
  const pause = planLimitPause({ credits: false }, w.f.t.clock.now());
  w.starts.pausePlanLimit(w.f.office.officeId as OfficeId, pause);
  return pause.detail;
}

/** The park of the run, with its flag, once the next session was refused. */
function expectParkedToResume(detail: string): void {
  expect(w.next).toEqual([]);
  expect(parks()).toEqual([["worker-failed", detail]]);
  expect(resumeOnLift()).toEqual([1]);
  expectEnded("plan-limit", "parked");
}

describe("no next session while the office's starts are paused (0020)", () => {
  it("a crash retry parks worker-failed with the pause's detail, to resume on lift", async () => {
    track();
    const detail = pauseForLimit();
    await ingestRecording("terminated");
    expectParkedToResume(detail);
  });

  it("the report feedback's resume parks the same way", async () => {
    track();
    const detail = pauseForLimit();
    await ingestRecording("report-invalid");
    expectParkedToResume(detail);
  });

  it("the handoff after a full context parks the same way", async () => {
    track();
    const detail = pauseForLimit();
    await ingestRecording("prompt-too-long");
    expectParkedToResume(detail);
  });

  it("the session after a restart parks the same way", async () => {
    await ingestRecording("terminated", true);
    setEndReason("crashed");
    const detail = pauseForLimit();
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expectParkedToResume(detail);
  });

  it("a failed adapter check takes the start failure's way: no session, no park to resume", async () => {
    track();
    w.adapterHolds.hold("claude-cli", [{ check: "probe", detail: "claude is not logged in" }]);
    await ingestRecording("terminated");
    expect(w.next).toEqual([]);
    // The worktree holds no work here: the claim is released and the story stays Ready.
    expect(w.released).toHaveLength(1);
    expect(resumeOnLift()).toEqual([]);
  });
});

describe("after a restart (decision Q6)", () => {
  it("decides an exit that was ingested but not decided", async () => {
    w.onNext = startedAgent;
    await ingestRecording("terminated", true);
    expect(w.next).toEqual([]);
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.next.map((request) => request.mode)).toEqual(["resume"]);
    expect(endReason()).toBe("crashed");
    // Decided once: the next session is the newest agent now.
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(0);
  });

  it("parks by-maintainer a run the maintainer paused before the upgrade, once (DIPO-344)", async () => {
    // The paused worker exited after its stdin closed; the pause intent is still open.
    await ingestRecording("terminated", true);
    setEndReason("paused");
    w.f.office.immediate(() =>
      recordIntent(w.f.office, w.f.run, "pause", `${LEGACY_PAUSE_TAG} req_1`, 0),
    );
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(parks()).toEqual([["by-maintainer", LEGACY_PAUSE_DETAIL]]);
    expect(intents()).toContainEqual(["pause", LEGACY_PAUSE_TAG, "run-ended"]);
    expect(findRun(w.f.office, w.f.run)?.endedAt).not.toBeNull();
    expect(w.next).toEqual([]);
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(0);
    expect(parks()).toHaveLength(1);
  });

  it("starts the resume of a crash decided before the stop", async () => {
    // The daemon stopped after the agent was ended `crashed`, before the next session started.
    await ingestRecording("terminated", true);
    setEndReason("crashed");
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.next.map((request) => request.mode)).toEqual(["resume"]);
    expect(w.next[0]?.why).toContain("before the daemon restarted");
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("starts the handoff of a full context decided before the stop", async () => {
    await ingestRecording("prompt-too-long", true);
    setEndReason("prompt-too-long");
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(w.next.map((request) => request.mode)).toEqual(["handoff"]);
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("resumes with an unanswered report feedback after a stop before the resume started", async () => {
    // The feedback was sent, the worker exited, and the daemon stopped before the resume.
    await ingestRecording("report-invalid", true);
    w.f.office.immediate(() =>
      recordIntent(
        w.f.office,
        w.f.run,
        "steer",
        `report-feedback ${w.f.agent} error_max_structured_output_retries`,
        0,
      ),
    );
    let openWhileStarting: (string | null)[] = [];
    w.onNext = () => {
      openWhileStarting = runIntents(w.f.office, w.f.run).map((intent) => intent.outcome);
    };
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    const text = reportFeedbackText("error_max_structured_output_retries");
    expect(w.next.map((request) => [request.mode, request.message])).toEqual([["resume", text]]);
    // Resolved only once the next session started.
    expect(openWhileStarting).toEqual([null]);
    expect(intents()).toEqual([["steer", "report-feedback", "resumed"]]);
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("keeps a report feedback recorded at the exit open until its resume started", async () => {
    // No feedback was sent before the exit: it is recorded at the exit, then the resume starts.
    let openWhileStarting: (string | null)[] = [];
    w.onNext = () => {
      openWhileStarting = runIntents(w.f.office, w.f.run).map((intent) => intent.outcome);
    };
    await ingestRecording("report-invalid-missing", true);
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(openWhileStarting).toEqual([null]);
    expect(intents()).toEqual([["steer", "report-feedback", "resumed"]]);
    expect(parks()).toEqual([]);
  });

  it("parks worker-failed, to resume when starts are not paused, a run a plan limit held before the upgrade (DIPO-359)", async () => {
    // The held worker exited; the old hold left its pause intent resolved and its signal raised.
    await ingestRecording("success-single", true);
    const at = w.f.t.clock.now();
    w.f.office.immediate(() => {
      const id = recordIntent(w.f.office, w.f.run, "pause", 'plan-limit {"scope":"session"}', at);
      resolveIntent(w.f.office, w.f.run, id, "plan-limit", at);
      raiseSignal(w.f.office, w.f.run, "plan-limit", at);
    });
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(1);
    expect(parks()).toEqual([["worker-failed", LEGACY_PLAN_LIMIT_DETAIL]]);
    expect(
      w.f.office.get<{ resume_on_lift: number }>(
        "select resume_on_lift from parks where office_id = $office_id",
      )?.resume_on_lift,
    ).toBe(1);
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    // No pause row: dipo resumes it at once, through the one resume path.
    await w.starts.idle();
    expect(w.lifted.map((park) => park.story)).toEqual(["DIPO-1"]);
    // Decided once.
    expect(await w.outcomes.redispatch(w.f.office.officeId)).toBe(0);
  });
});

describe("usage on resume (AC #9)", () => {
  it("the resume pair split at its first exit counts the second process's totals once", () => {
    const recording = readRecording(join(RECORDINGS_DIR, "resume"));
    const lines = hostLines(recording);
    const cut = lines.findIndex((line) => line.ch === "exit") + 1;
    appendLines(w.f.eventFile, lines.slice(0, cut));
    const ingestor = new Ingestor({ office: w.f.office, clock: w.f.t.clock, pricing: null });
    w.ingestor = ingestor;
    const first = initialState({ plannedModel: "haiku" });
    ingestor.track(target(w.f, claude, first as unknown as ParseState));
    const stored = w.f.office.get<{ parse_state: string }>(
      "select parse_state from ingest_cursors where office_id = $office_id and agent_id = $agent",
      { agent: w.f.agent },
    );
    const previous = JSON.parse(stored?.parse_state ?? "{}") as ClaudeParseState;
    // The second host of the run starts after what the first one wrote.
    const offset = statSync(w.f.eventFile).size;
    const agent = w.f.t.ids.next("agt");
    recordWorkerHost(
      w.f.office,
      {
        pid: 4243,
        startTimeMs: 1,
        runId: w.f.run,
        agentId: agent,
        socketPath: join(w.dir, "host2.sock"),
        protocolVersion: 1,
        runDir: w.dir,
        eventFile: w.f.eventFile,
      },
      w.f.t.clock,
    );
    w.f.office.immediate(() =>
      w.f.office.run(
        `update worker_hosts set processed_offset = $offset
          where office_id = $office_id and agent_id = $agent`,
        { offset, agent },
      ),
    );
    appendLines(w.f.eventFile, lines.slice(cut));
    ingestor.track({
      ...target(
        w.f,
        claude,
        initialState(nextSessionOptions(previous, true, "haiku")) as unknown as ParseState,
      ),
      agent,
    });
    const totals = w.f.office.get<{
      input: number;
      output: number;
      cache_create: number;
      cache_read: number;
    }>(
      `select sum(input) as input, sum(output) as output, sum(cache_create) as cache_create,
         sum(cache_read) as cache_read from usage_totals where office_id = $office_id and run_id = $run`,
      { run: w.f.run },
    );
    expect(totals).toEqual({ input: 4, output: 606, cache_create: 2160, cache_read: 9029 });
    // The second agent ingested only its own process: one message, not the first one again.
    const messages = w.f.office.all<{ message_id: string }>(
      "select message_id from usage_messages where office_id = $office_id and agent_id = $agent",
      { agent },
    );
    expect(messages.map((row) => row.message_id)).toEqual(["msg-2"]);
  });
});

describe("endRun finalizes usage (AC #10)", () => {
  it("a run that ends before its exit is ingested reaches usage_daily, and later usage only adds its change", async () => {
    const lines = hostLines(readRecording(join(RECORDINGS_DIR, "success-single")));
    const result = lines.findIndex(
      (line) => line.ch === "stdout" && line.data.includes('"type":"result"'),
    );
    appendLines(w.f.eventFile, lines.slice(0, result));
    const ingestor = new Ingestor({ office: w.f.office, clock: w.f.t.clock, pricing: null });
    w.ingestor = ingestor;
    ingestor.track(
      target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    );
    const daily = () =>
      w.f.office.get<{ input: number; output: number; cache_create: number; runs: number }>(
        `select sum(input) as input, sum(output) as output, sum(cache_create) as cache_create,
           sum(runs) as runs from usage_daily where office_id = $office_id`,
      );
    const finals = () =>
      w.f.office.get<{ input: number; output: number; cache_create: number }>(
        `select sum(input) as input, sum(output) as output, sum(cache_create) as cache_create
          from usage_totals where office_id = $office_id and final = 1`,
      );
    expect(daily()?.input ?? null).toBeNull();
    // The run ends (a park, a stop) with no exit line ingested.
    w.f.office.immediate(() => {
      endRun(w.f.office, w.f.run, w.f.t.clock.now(), "stopped");
      appendEntries(w.f.office, [], { at: w.f.t.clock.now() });
    });
    expect(daily()).toEqual({ ...finals(), runs: 1 } as never);
    expect(daily()?.input).toBeGreaterThan(0);
    // The turn that answers the stop arrives later: only its change is added.
    appendLines(w.f.eventFile, lines.slice(result));
    ingestor.pass(w.f.run, w.f.agent);
    expect(daily()).toEqual({ ...finals(), runs: 1 } as never);
    expect(finals()?.output).toBe(155);
  });
});

describe("a start the adapter refuses at system/init (DIPO-108)", () => {
  it("stops the worker before its first tool call, without a park, and the story stays Ready", async () => {
    track();
    // safety-main-git runs Bash right after its system/init; here that init lists a plugin the
    // office does not allow. The worker is the fake process, read chunk by chunk as the host does,
    // and the ops run control sends reach it before the next chunk.
    const recording = withInitPlugins(readRecording(join(RECORDINGS_DIR, "safety-main-git")), [
      "warp@claude-code-warp",
    ]);
    const adapter = claudeCliAdapter(
      context({ plugins: { installed: ["warp@claude-code-warp"], allowed: [] } }),
      {
        spawn: () => {
          throw new Error("no process is spawned through the adapter");
        },
        clock: w.f.t.clock,
      },
    );
    const ingestor = new Ingestor({
      office: w.f.office,
      clock: w.f.t.clock,
      pricing: null,
      hooks: w.control.hooks,
    });
    w.ingestor = ingestor;
    ingestor.track(
      target(
        w.f,
        adapter as unknown as IngestAdapter,
        initialState({ plannedModel: "haiku" }) as unknown as ParseState,
        {
          budgetLimit: ROOMY.budgetTokens,
        },
      ),
    );
    const child = fakeSpawn(recording, new ManualClock()).spawn({
      cmd: ["claude", "-p"],
      stdin: "pipe",
    }) as FakeProcess;
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const read: string[] = [];
    const sent: HostOp[][] = [];
    let t = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      read.push(text);
      appendLines(w.f.eventFile, [{ t: (t += 1), ch: "stdout", data: text }]);
      ingestor.pass(w.f.run, w.f.agent);
      await w.control.idle();
      for (const ops of w.sent.splice(0)) {
        sent.push(ops);
        for (const op of ops) {
          if ("closeStdin" in op) child.stdin?.end();
          if ("signal" in op && op.afterMs === undefined) child.kill(op.signal);
        }
      }
    }
    const exit = await child.exited;
    appendLines(w.f.eventFile, [{ t: t + 1, ch: "exit", data: JSON.stringify(exit) }]);
    ingestor.pass(w.f.run, w.f.agent);
    await w.control.idle();

    // Stopped at once, at its system/init: the tool call after it was never reached.
    expect(sent).toEqual([
      [{ closeStdin: true }, { signal: "SIGTERM" }, { signal: "SIGKILL", afterMs: 30_000 }],
    ]);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(exit).toEqual({ code: 143, signal: null });
    expect(read.some((text) => text.includes('"subtype":"init"'))).toBe(true);
    expect(read.some((text) => text.includes('"tool_use"'))).toBe(false);
    // Ended through startFailed: adapter held, claim released, no park, the story stays Ready.
    expect(parks()).toEqual([]);
    expect(w.released).toEqual(["start-failed"]);
    expect(w.holds.map((hold) => [hold.adapter, hold.failures[0]?.check])).toEqual([
      ["claude-cli", "start-failed"],
    ]);
    expect(w.holds[0]?.failures[0]?.detail).toContain("plugin warp@claude-code-warp");
    // The stop sent at init and the release at the exit, both start-failed; no init-rejected one.
    expect(intents()[0]).toEqual(["stop", "start-failed", "startFailed"]);
    expect(intents().every(([, tag]) => tag === "start-failed")).toBe(true);
    const notice = notices().find((n) => n.code === "run.startFailed");
    expect(notice?.text).toContain("the story stays Ready");
    expect(notices().some((n) => n.code === "run.initRejected")).toBe(false);
    expect(w.next).toEqual([]);
    expectEnded("start-failed", "start-failed");
  });
});

describe("a turn problem whose intent cannot be stored (DIPO-123)", () => {
  const PROBLEMS: [TurnProblem, string, string][] = [
    [
      { kind: "error", detail: "error_during_execution (an API error)" },
      "reassign",
      "new-session:error",
    ],
    [
      { kind: "contextFull", detail: "prompt_too_long: the context is full" },
      "reassign",
      "new-session:context-full",
    ],
    [{ kind: "startFailed", detail: "startup_failure_reason sandbox" }, "stop", "start-failed"],
  ];
  for (const [problem, kind, tag] of PROBLEMS) {
    it(`${problem.kind}: the next cap tick stores and sends its intent once`, async () => {
      track();
      w.f.t.state.connection.exec(
        `create trigger intent_fails before insert on run_intents
         begin select raise(abort, 'disk I/O error'); end`,
      );
      w.control.onWorkerEvents(w.f.run, [turnWith(problem)]);
      await w.control.idle();
      expect(w.sent).toEqual([]);
      expect(runIntents(w.f.office, w.f.run)).toEqual([]);
      expect(w.control.live(w.f.run)).toBe(true);
      w.f.t.state.connection.exec("drop trigger intent_fails");
      w.f.t.clock.advance(CAP_TICK_MS);
      await w.control.idle();
      expect(w.sent).toEqual([CLOSE]);
      expect(
        runIntents(w.f.office, w.f.run).map((i) => [i.kind, intentTag(i.detail), i.state]),
      ).toEqual([[kind, tag, "sent"]]);
      expect(w.control.live(w.f.run)).toBe(false);
      // Later ticks send nothing more.
      w.f.t.clock.advance(CAP_TICK_MS * 3);
      await w.control.idle();
      expect(w.sent).toHaveLength(1);
      expect(runIntents(w.f.office, w.f.run)).toHaveLength(1);
    });
  }
});
