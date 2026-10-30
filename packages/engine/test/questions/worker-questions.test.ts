// The question of a worker's report through the live-question rule and its wait (DIPO-272 AC #5,
// 0021 section 11, DIPO-279, DIPO-284, DIPO-159, 0020 section 7): run control and the permission
// wait wired as `composeRuns` wires them, on a migrated state database with one claimed story run,
// a fake park writer, a fake question park resumer and a steering fake. A question is live only
// while a TUI is connected, for at most `timeouts.questionWaitMinutes`; otherwise, once the wait
// ends and once the last TUI closes, the story parks `ambiguous-spec` with the question, which the
// park carries. A question open when its run ends, or answered while the run is ending, reaches
// the run's park or next session.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { mirrorStory } from "../run/park-fixture";
import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import {
  PermissionAsks,
  type QuestionParkResumer,
  workerAnswerText,
} from "../../src/questions/permissions";
import { findQuestion, openQuestions } from "../../src/questions/questions";
import { type BranchPark, RunControl } from "../../src/run";
import { insertRun } from "../../src/records";
import { questionWaitMs, runTotals } from "../../src/records/caps";
import { heldFeedback } from "../../src/run/feedback";
import { resolvePark } from "../../src/run/park";
import { findRun } from "../../src/records/run-records";
import { reopen } from "../../src/run/rounds";
import { activeSignals } from "../../src/records/signals";
import { addStory } from "../../src/records/story-keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps, HostOp, WorkerEvent } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture, loggedEvents } from "../ingest/helpers";
import { SCRIPTS } from "../workers/scripts";
import { backlogLayout } from "../story-store/backlog";

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const QUESTION = "Which greeting should the CLI print?";
const MINUTE = 60_000;
/** `timeouts.questionWaitMinutes` of the office defaults. */
const WAIT_MINUTES = OFFICE_DEFAULTS.timeouts.questionWaitMinutes;

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly asks: PermissionAsks;
  readonly sent: HostOp[][];
  readonly work: WorkRef;
  /** The question park resumes `work.answer` asked for. */
  readonly resumed: { run: string; parkId: number; answer: string }[];
  /** Whether a TUI is connected, read at the moment of each question. */
  tui: boolean;
  /** The office configuration `PermissionAsks` reads. */
  config: OfficeConfig;
  /** Holds the park writer until it resolves, when set. */
  gate: Promise<void> | null;
}

let w: World;

function asksFor(
  world: World,
  control: RunControl,
  options: { exitDecides?: boolean } = {},
): PermissionAsks {
  const resumer: QuestionParkResumer = {
    resume: async (_ctx, run, park, text) => {
      world.resumed.push({ run: run.runId, parkId: park.parkId, answer: text });
      return { run: run.runId };
    },
    replay: async () => null,
  };
  return new PermissionAsks({
    stories: backlogLayout,
    clock: world.f.t.clock,
    ids: world.f.t.ids,
    offices: { get: () => world.f.office, config: () => world.config },
    steering: {
      send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
        world.sent.push([...ops]);
        return { ok: true } as const;
      },
    },
    encode,
    presence: { tuiConnected: () => world.tui },
    ending: (run) => control.isEnding(run),
    parkQuestion: (_office, run, question) => {
      control.parkOnQuestion(run, question);
    },
    questionParks: () => resumer,
    ...(options.exitDecides === undefined ? {} : { exitDecides: options.exitDecides }),
  });
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "worker-question-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const world = {
    dir,
    f,
    sent,
    tui: true,
    resumed: [],
    config: OFFICE_DEFAULTS,
    gate: null,
  } as unknown as World;
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      sent.push([...ops]);
      return { ok: true } as const;
    },
  };
  let asks: PermissionAsks | null = null;
  const control = new RunControl({
    stories: backlogLayout,
    clock: f.t.clock,
    offices: { get: () => f.office },
    // Question ids for the question a park asks itself (DIPO-159).
    ids: f.t.ids,
    writer: {
      write: async (): Promise<BranchPark> => {
        if (world.gate !== null) await world.gate;
        return {
          commit: "c".repeat(40),
          lastGoodCommit: "a".repeat(40),
          from: "In Progress",
          pushed: true,
          pushError: null,
        };
      },
    },
    steering,
    encode,
    questions: () => asks ?? undefined,
  });
  asks = asksFor(world, control);
  (world as { control: RunControl }).control = control;
  (world as { asks: PermissionAsks }).asks = asks;
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
  // The story as the index read it, so a park reaches the mirror (DIPO-360).
  office.immediate(() => mirrorStory(office, { key, story: "DIPO-1" }));
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
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      claimedAt: f.t.clock.now(),
    });
    // The session's agent, which ingestion records from the worker's start.
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', 0)`,
      { agent: f.agent, run },
    );
  });
  track(world);
  w = world;
});

afterEach(async () => {
  await w.control.idle();
  await w.asks.idle();
  w.asks.close();
  w.control.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

function track(world: World = w): void {
  world.control.track(world.f.office.officeId, {
    runId: world.f.run,
    work: world.work,
    caps: ROOMY,
    startedAt: world.f.t.clock.now(),
  });
}

/** The worker's blocked report with a question, as one ingestion pass hands it to run control. */
async function blockedQuestion(question = QUESTION): Promise<void> {
  const [started, turn, waiting] = SCRIPTS["blocked-question"] as WorkerEvent[];
  if (turn?.t !== "turn" || turn.report === null) throw new Error("fixture changed");
  w.control.onWorkerEvents(
    w.f.run,
    [
      started as WorkerEvent,
      { ...turn, report: { ...turn.report, question } },
      waiting as WorkerEvent,
    ],
    w.f.agent,
  );
  await w.control.idle();
}

function parks(): { reason: string; detail: string }[] {
  return w.f.office.all(
    "select reason, detail from parks where office_id = $office_id order by rowid",
  );
}

function parkIds(): number[] {
  return w.f.office
    .all<{ park_id: number }>(
      "select park_id from parks where office_id = $office_id order by park_id",
    )
    .map((row) => row.park_id);
}

function types(): string[] {
  return loggedEvents(w.f.office).map((event) => event.type);
}

/** Every op sent to the worker that carries the maintainer's answer. */
function answersSent(): HostOp[][] {
  return w.sent.filter((ops) =>
    ops.some((op) => JSON.stringify(op).includes("The maintainer answered your question")),
  );
}

let requests = 0;
function answer(
  args: Record<string, unknown>,
  asks: PermissionAsks = w.asks,
): Promise<CommandReply> {
  requests += 1;
  return executeCommand(
    {
      registry: buildRegistry([asks.feature]),
      offices: stateOfficeDirectory(w.f.t.state),
      clock: w.f.t.clock,
      ids: w.f.t.ids,
      softwareRequests: new MemoryRequestTable(w.f.t.clock),
    },
    {
      requestId: RequestId.parse(
        `01J9ZK5Q8W3V4X6Y7Z${(80_000 + requests).toString().padStart(8, "0")}`,
      ),
      name: "work.answer",
      args,
      origin: "cli",
      confirmed: false,
      office: w.f.office.officeId as OfficeId,
    },
  );
}

/** Lets the clock pass `ms`, firing the timers due, and waits for what they started. */
async function pass(ms: number): Promise<void> {
  w.f.t.clock.advance(ms);
  await w.control.idle();
}

describe("a worker's question with a TUI connected (AC #1 and #2)", () => {
  it("is asked live with its wait: a question linked to the run and question.asked, no health of its own (0009), and nothing parks", async () => {
    const asked = w.f.t.clock.now();
    await blockedQuestion();
    expect(parks()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.control.isEnding(w.f.run)).toBe(false);
    const [question] = openQuestions(w.f.office, w.f.run);
    expect(question).toMatchObject({
      kind: "question",
      runId: w.f.run,
      text: QUESTION,
      hook: null,
      parkId: null,
      waitUntil: asked + WAIT_MINUTES * MINUTE,
    });
    expect(types()).toContain("question.asked");
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    expect(types()).not.toContain("work.observed");
  });

  it("sends an answer within the wait to the waiting worker as its next message and closes the question", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    await pass((WAIT_MINUTES - 1) * MINUTE);
    const reply = await answer({ question: question?.questionId, text: "  Hello, Ada!  " });
    expect(reply.ok).toBe(true);
    if (reply.ok)
      expect(reply.result).toEqual({ question: question?.questionId, delivered: "now" });
    expect(w.sent).toEqual([encode({ kind: "answer", text: workerAnswerText("Hello, Ada!") })]);
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedHow: "answered",
      answer: "Hello, Ada!",
      decision: null,
      delivered: "now",
    });
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    // The answer stopped the wait: its end parks nothing.
    await pass(2 * MINUTE);
    expect(parks()).toEqual([]);
    // Answered once: a second answer finds nothing waiting.
    const again = await answer({ question: question?.questionId, text: "Hi" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("question.closed");
  });

  it("leaves the wait out of the minute cap (0020 section 7)", async () => {
    // A 10-minute cap, and the question waits 14 of its 15 minutes: no cap fires.
    w.f.office.immediate(() =>
      w.f.office.run("update runs set max_minutes = 10 where office_id = $office_id"),
    );
    const start = w.f.t.clock.now();
    await pass(2 * MINUTE);
    await blockedQuestion();
    await pass(14 * MINUTE);
    expect(parks()).toEqual([]);
    const now = w.f.t.clock.now();
    expect(questionWaitMs(w.f.office, w.f.run, now)).toBe(14 * MINUTE);
    expect(runTotals(w.f.office, w.f.run as RunId, start, now).elapsedMs).toBe(2 * MINUTE);
    // Once answered, the time counts again.
    const [question] = openQuestions(w.f.office, w.f.run);
    await answer({ question: question?.questionId, text: "Hello" });
    await pass(3 * MINUTE);
    const later = w.f.t.clock.now();
    expect(runTotals(w.f.office, w.f.run as RunId, start, later).elapsedMs).toBe(5 * MINUTE);
  });

  it("refuses an answer without text, and keeps waiting", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    for (const args of [{ question: question?.questionId, text: "   " }]) {
      const reply = await answer(args);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("args.invalid");
    }
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    expect(w.sent).toEqual([]);
  });

  it("is expired at office load when a previous daemon left it open (the load step of work.answer)", async () => {
    await blockedQuestion();
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    // A new daemon knows no live question: its load step closes the one left open.
    w.asks.close();
    const step = buildRegistry([w.asks.feature])
      .loadSteps()
      .find((candidate) => candidate.name === "expire open permission questions");
    await step?.run({
      officeId: w.f.office.officeId as OfficeId,
      office: w.f.office,
      path: w.dir,
      commonDir: w.dir,
      config: OFFICE_DEFAULTS,
      clock: w.f.t.clock,
      ids: w.f.t.ids,
    });
    expect(openQuestions(w.f.office, w.f.run)).toEqual([]);
    expect(
      w.f.office.get<{ closed_how: string }>(
        "select closed_how from questions where office_id = $office_id",
      ),
    ).toEqual({ closed_how: "expired" });
  });
});

describe("a worker's question nobody answers in time (AC #2 and #3)", () => {
  it("closes stdin and parks ambiguous-spec (question) when the wait ends, the question linked to the park", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    await pass(WAIT_MINUTES * MINUTE - 1);
    expect(parks()).toEqual([]);
    await pass(1);
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    const parked = findQuestion(w.f.office, question?.questionId ?? "");
    expect(parked?.closedAt).toBeNull();
    expect(parked?.parkId).toBe(parkIds()[0] ?? -1);
    // The park asks no second question: it carries the live one.
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    // The wait counts up to the park, not after it.
    expect(questionWaitMs(w.f.office, w.f.run, w.f.t.clock.now() + 60 * MINUTE)).toBe(
      WAIT_MINUTES * MINUTE,
    );
  });

  it("resumes the park with a later answer through dipo answer --text", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    await pass(WAIT_MINUTES * MINUTE);
    const reply = await answer({ question: question?.questionId, text: " Hello, Ada! " });
    expect(reply).toMatchObject({
      ok: true,
      result: { question: question?.questionId, delivered: "on-resume", run: w.f.run },
    });
    expect(w.resumed).toEqual([
      { run: w.f.run, parkId: parkIds()[0] ?? -1, answer: "Hello, Ada!" },
    ]);
    // Nothing went to the stopped worker.
    expect(answersSent()).toEqual([]);
  });

  it("parks with the question at once when the last TUI closes while it waits (DIPO-284)", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    // Another TUI still open: nothing changes.
    w.asks.presenceChanged();
    expect(parks()).toEqual([]);
    w.tui = false;
    w.asks.presenceChanged();
    await w.control.idle();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    // The question stays open as the park's, and its answer resumes the park.
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedAt: null,
      parkId: parkIds()[0],
    });
    const late = await answer({ question: question?.questionId, text: "Hello" });
    expect(late).toMatchObject({ ok: true, result: { delivered: "on-resume", run: w.f.run } });
    expect(w.resumed).toHaveLength(1);
    // Its wait timer is gone with it: the end of the wait parks nothing more.
    await pass(WAIT_MINUTES * MINUTE);
    expect(parks()).toHaveLength(1);
  });

  it("parks at once when the office waits zero minutes", async () => {
    w.config = {
      ...OFFICE_DEFAULTS,
      timeouts: { ...OFFICE_DEFAULTS.timeouts, questionWaitMinutes: 0 },
    };
    await blockedQuestion();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: QUESTION }]);
  });
});

describe("a worker's question without a TUI (AC #1)", () => {
  it("parks ambiguous-spec at once, the park asking the question: linked to the run and the park, question.asked emitted", async () => {
    w.tui = false;
    await blockedQuestion();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    const [question] = openQuestions(w.f.office, w.f.run);
    expect(question).toMatchObject({
      kind: "question",
      runId: w.f.run,
      text: QUESTION,
      parkId: parkIds()[0],
      waitUntil: null,
    });
    expect(types()).toContain("question.asked");
    // It never waited live.
    expect(questionWaitMs(w.f.office, w.f.run, w.f.t.clock.now() + MINUTE)).toBe(0);
    const reply = await answer({ question: question?.questionId, text: "Hello" });
    expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume", run: w.f.run } });
  });

  it("parks a blocked report without a question with its reason and asks nothing", async () => {
    w.tui = false;
    const [started, turn] = SCRIPTS["blocked-question"] as WorkerEvent[];
    if (turn?.t !== "turn" || turn.report === null) throw new Error("fixture changed");
    const { question: _question, ...report } = turn.report;
    w.control.onWorkerEvents(
      w.f.run,
      [started as WorkerEvent, { ...turn, report: { ...report, summary: "The box has no jq." } }],
      w.f.agent,
    );
    await w.control.idle();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: "The box has no jq." }]);
    expect(openQuestions(w.f.office, w.f.run)).toEqual([]);
  });
});

describe("a worker's question when its run ends while it waits (DIPO-272, DIPO-289 AC #7 to #10)", () => {
  const capped: WorkerEvent = {
    t: "turn",
    report: null,
    totals: {},
    numTurns: 1,
    terminal: "max_turns",
    capped: "turn cap (--max-turns) after 1 turns",
  };

  it("becomes the park's question when a cap fires during the live wait, and its answer waits for the next session", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    w.control.onWorkerEvents(w.f.run, [capped], w.f.agent);
    await w.control.idle();
    expect(parks().map((park) => park.reason)).toEqual(["budget-exceeded"]);
    // The last TUI closing while the run ends, and the worker's exit, leave it to the park.
    w.tui = false;
    w.asks.presenceChanged();
    w.asks.onEnded(w.f.office, w.f.run);
    const parked = findQuestion(w.f.office, question?.questionId ?? "");
    expect(parked?.closedAt).toBeNull();
    expect(parked?.parkId).toBe(parkIds()[0] ?? -1);
    expect(parks()).toHaveLength(1);

    const reply = await answer({ question: question?.questionId, text: "Hello, Ada!" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ question: question?.questionId, delivered: "on-resume" });
    }
    // A budget park is not resumed by an answer: the story stays Parked, the answer is held.
    expect(w.resumed).toEqual([]);
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedHow: "answered",
      answer: "Hello, Ada!",
    });
    expect(heldFeedback(w.f.office, w.f.run).texts).toEqual([workerAnswerText("Hello, Ada!")]);
  });

  it("holds an answer given after a cap began, before the run's end is ingested, instead of sending it to the stopping worker (AC #7)", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    let open!: () => void;
    w.gate = new Promise((resolve) => {
      open = resolve;
    });
    w.control.onWorkerEvents(w.f.run, [capped], w.f.agent);
    expect(w.control.isEnding(w.f.run)).toBe(true);
    const reply = await answer({ question: question?.questionId, text: "Hello, Ada!" });
    expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume" } });
    expect(answersSent()).toEqual([]);
    open();
    await w.control.idle();
    expect(parks().map((park) => park.reason)).toEqual(["budget-exceeded"]);
    expect(heldFeedback(w.f.office, w.f.run).texts).toEqual([workerAnswerText("Hello, Ada!")]);
    // The park carries it, answered: it waits for nothing more.
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedHow: "answered",
      parkId: parkIds()[0],
    });
  });

  it("takes an answer as held for a question a run being ended let go of before its park carried it (AC #8)", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    let open!: () => void;
    w.gate = new Promise((resolve) => {
      open = resolve;
    });
    w.control.onWorkerEvents(w.f.run, [capped], w.f.agent);
    // The worker's exit is ingested while the park is still being written: the run lets it go.
    w.asks.onEnded(w.f.office, w.f.run);
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedAt: null,
      parkId: null,
    });
    const reply = await answer({ question: question?.questionId, text: "Hello, Ada!" });
    expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume" } });
    open();
    await w.control.idle();
    expect(heldFeedback(w.f.office, w.f.run).texts).toEqual([workerAnswerText("Hello, Ada!")]);
    expect(findQuestion(w.f.office, question?.questionId ?? "")?.parkId).toBe(parkIds()[0] ?? -1);
  });

  it("leaves the question of a worker that exits on its own to the park its exit decision makes (AC #9)", async () => {
    const asks = asksFor(w, w.control, { exitDecides: true });
    w.asks.close();
    (w as { asks: PermissionAsks }).asks = asks;
    // run control asks through the permission wait it was built with: ask through this one.
    expect(asks.askWorker(w.f.office, w.f.run, w.f.agent, QUESTION)).toBe(true);
    const [question] = openQuestions(w.f.office, w.f.run);
    asks.onEnded(w.f.office, w.f.run);
    expect(findQuestion(w.f.office, question?.questionId ?? "")?.closedAt).toBeNull();
    // The exit decision parks the story: the park carries the question.
    w.control.begin(w.f.run, {
      intent: "park",
      ops: [],
      reason: "worker-failed",
      detail: "the worker crashed",
    });
    await w.control.idle();
    asks.afterExit(w.f.office.officeId as OfficeId, w.f.run);
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedAt: null,
      parkId: parkIds()[0],
    });
  });

  it("closes the question of a worker that exits on its own when no park follows (AC #9)", async () => {
    const asks = asksFor(w, w.control, { exitDecides: true });
    w.asks.close();
    (w as { asks: PermissionAsks }).asks = asks;
    expect(asks.askWorker(w.f.office, w.f.run, w.f.agent, QUESTION)).toBe(true);
    const [question] = openQuestions(w.f.office, w.f.run);
    asks.onEnded(w.f.office, w.f.run);
    asks.afterExit(w.f.office.officeId as OfficeId, w.f.run);
    expect(findQuestion(w.f.office, question?.questionId ?? "")?.closedHow).toBe("ended");
    expect(parks()).toEqual([]);
    // Its wait was stopped with the exit.
    await pass(WAIT_MINUTES * MINUTE);
    expect(parks()).toEqual([]);
  });

  it("expires a park's carried question once the park is resolved another way, and a later park of the story asks its own (AC #10)", async () => {
    w.tui = false;
    await blockedQuestion();
    const [first] = openQuestions(w.f.office, w.f.run);
    const [firstPark] = parkIds();
    // The maintainer drops or reconcile resolves the park: its question waits for nothing, and
    // the resolution says so with its question.closed (DIPO-344).
    const closed = w.f.office.immediate(() =>
      resolvePark(w.f.office, firstPark ?? -1, "drop", w.f.t.clock.now()),
    );
    expect(closed).toEqual([
      expect.objectContaining({
        type: "question.closed",
        delta: { question: first?.questionId },
      }),
    ]);
    expect(findQuestion(w.f.office, first?.questionId ?? "")?.closedHow).toBe("expired");
    const stale = await answer({ question: first?.questionId, text: "Too late" });
    expect(stale).toMatchObject({ ok: false, error: { code: "question.closed" } });

    // A later park of the same story: the worker exited, the run works again and parks on a new
    // question.
    w.control.onEnded(w.f.run);
    w.f.office.immediate(() =>
      reopen(w.f.office, findRun(w.f.office, w.f.run as RunId)!, w.f.t.clock.now(), {
        kind: "fix",
      }),
    );
    track();
    await blockedQuestion("Which exit code?");
    const [, secondPark] = parkIds();
    const open = openQuestions(w.f.office, w.f.run);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ text: "Which exit code?", parkId: secondPark });
    expect(findQuestion(w.f.office, first?.questionId ?? "")).toMatchObject({
      closedHow: "expired",
      parkId: firstPark,
    });
    const reply = await answer({ question: open[0]?.questionId, text: "Exit 2." });
    expect(reply).toMatchObject({ ok: true, result: { run: w.f.run } });
    expect(w.resumed).toEqual([{ run: w.f.run, parkId: secondPark ?? -1, answer: "Exit 2." }]);
  });
});
