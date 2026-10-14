// Worker outcomes (DIPO-51), fast and local: one test per 0017 scenario of the story, on the run
// control harness of control.test.ts (a migrated state database with one claimed story run, the
// real DIPO-45 ingestion of committed Claude recordings with run control as its hooks), with
// worker outcomes wired in and the run's next session stubbed. Every run that ends writes its
// `run_outcomes` row through `endRun`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { StoryId, type RunId, type WorkRef } from "@dipsaus-orchestrator/contract";
import { readRecording } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  endRun,
  findRun,
  insertRun,
  intentTag,
  type NextSessionOutcome,
  type NextSessionRequest,
  openWait,
  recordIntent,
  reportFeedbackText,
  RunControl,
  runIntents,
  runOutcome,
  RunOutcomes,
} from "../../src/run";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import { workView } from "../../src/views/work";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
  nextSessionOptions,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import type { LaunchCheckFailure } from "../../src/workers/hold";
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
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
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

describe("a plan limit (AC #8)", () => {
  it("plan-limit-rejected: closes stdin, writes the wait fact, shows limited, never parks", async () => {
    track();
    await ingestRecording("plan-limit-rejected");
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    expect(intents()).toEqual([["pause", "plan-limit", "plan-limit"]]);
    const wait = openWait(w.f.office, w.f.run);
    expect(wait?.scope).toBe("unknown");
    expect(wait?.resetsAt).toBe(new Date(1_791_827_400 * 1000).toISOString());
    expect(wait?.since).toBe(w.f.t.clock.now());
    const observed = loggedEvents(w.f.office).filter((event) => event.type === "work.observed");
    expect(observed.map((event) => (event.data as { signal: string }).signal)).toEqual([
      "plan-limit",
    ]);
    expect(workView(w.f.office, w.f.run as RunId)?.health).toBe("limited");
    expect(parks()).toEqual([]);
    expect(w.next).toEqual([]);
    expectActive();
  });

  it("plan-limit-429: a 429 turn holds the same way, without a reset time", async () => {
    track();
    await ingestRecording("plan-limit-429");
    expect(intents()).toEqual([["pause", "plan-limit", "plan-limit"]]);
    expect(openWait(w.f.office, w.f.run)).toEqual({ scope: "unknown", since: w.f.t.clock.now() });
    expect(parks()).toEqual([]);
    expectActive();
  });

  it("credits_required holds the adapter with a notice", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [{ t: "limit", status: "rejected", creditsRequired: true }]);
    await w.control.idle();
    expect(openWait(w.f.office, w.f.run)?.scope).toBe("credits");
    expect(w.holds.map((hold) => hold.failures[0]?.check)).toEqual(["credits"]);
    expect(notices().map((n) => n.code)).toContain("run.planLimit");
    expect(parks()).toEqual([]);
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

  it("leaves a run waiting for a plan-limit reset alone", async () => {
    track();
    await ingestRecording("plan-limit-rejected");
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
