// The question of a worker's report (DIPO-272, DIPO-159, DIPO-428; 0001, 0020): run control and
// `work.answer` wired as `composeRuns` wires them, on a migrated state database with one claimed
// story run, a fake park writer, a fake question park resumer and a steering fake. A blocked report
// parks its story `ambiguous-spec` at once, whichever client is connected: no input of the engine
// says whether a TUI is open, and no worker waits on stdin for an answer. The park asks the
// question, and its answer resumes the park; an answer to a question another park carries waits for
// the run's next session.

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
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  PermissionAsks,
  type QuestionParkResumer,
  workerAnswerText,
} from "../../src/questions/permissions";
import { findQuestion, insertWorkerQuestion, openQuestions } from "../../src/run-state/questions";
import { type BranchPark, RunControl } from "../../src/run";
import { insertRun } from "../../src/records";
import { heldFeedback } from "../../src/run/feedback";
import { resolvePark } from "../../src/run/park";
import { findRun } from "../../src/records/run-records";
import { reopen } from "../../src/run-state/rounds";
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

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly asks: PermissionAsks;
  readonly sent: HostOp[][];
  readonly work: WorkRef;
  /** The question park resumes `work.answer` asked for. */
  readonly resumed: { run: string; parkId: number; answer: string }[];
}

let w: World;

function asksFor(world: World): PermissionAsks {
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
    questionParks: () => resumer,
  });
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "worker-question-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const world = { dir, f, sent, resumed: [] } as unknown as World;
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      sent.push([...ops]);
      return { ok: true } as const;
    },
  };
  const control = new RunControl({
    stories: backlogLayout,
    clock: f.t.clock,
    offices: { get: () => f.office },
    // Question ids for the question a park asks itself (DIPO-159).
    ids: f.t.ids,
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
  });
  (world as { control: RunControl }).control = control;
  (world as { asks: PermissionAsks }).asks = asksFor(world);
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

/** The office load step of `work.answer` that closes the questions a previous daemon left open. */
async function loadStep(): Promise<void> {
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
}

describe("a worker's question parks its story at once (AC #1)", () => {
  it("parks ambiguous-spec at once, the park asking the question: stdin closed, the question linked to the run and the park, question.asked emitted", async () => {
    await blockedQuestion();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    const [question] = openQuestions(w.f.office, w.f.run);
    expect(question).toMatchObject({
      kind: "question",
      runId: w.f.run,
      text: QUESTION,
      parkId: parkIds()[0],
      closedAt: null,
    });
    expect(Object.keys(question ?? {})).not.toContain("waitUntil");
    expect(types()).toContain("question.asked");
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    // No worker waits for the answer: time passing parks nothing more and sends nothing.
    await pass(60 * MINUTE);
    expect(parks()).toHaveLength(1);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
  });

  it("parks a blocked report without a question with its reason and asks nothing", async () => {
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

describe("an answer to a worker's question (DIPO-159, DIPO-272)", () => {
  it("resumes the question park through dipo answer --text, and sends nothing to the stopped worker", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    const reply = await answer({ question: question?.questionId, text: " Hello, Ada! " });
    expect(reply).toMatchObject({
      ok: true,
      result: { question: question?.questionId, delivered: "on-resume", run: w.f.run },
    });
    expect(w.resumed).toEqual([
      { run: w.f.run, parkId: parkIds()[0] ?? -1, answer: "Hello, Ada!" },
    ]);
    expect(answersSent()).toEqual([]);
  });

  it("refuses an answer without text, and the question stays open", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    const reply = await answer({ question: question?.questionId, text: "   " });
    expect(reply).toMatchObject({ ok: false, error: { code: "args.invalid" } });
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    expect(w.resumed).toEqual([]);
  });

  it("holds the answer to a question another park carries for the run's next session", async () => {
    // A cap park that carries the question of an earlier binary's live wait.
    w.control.begin(w.f.run, {
      intent: "park",
      ops: [],
      reason: "budget-exceeded",
      detail: "turn cap 61 of 60",
    });
    await w.control.idle();
    const [parkId] = parkIds();
    w.f.office.immediate(() =>
      insertWorkerQuestion(w.f.office, {
        questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
        runId: w.f.run,
        agentId: w.f.agent,
        text: QUESTION,
        at: w.f.t.clock.now(),
        ...(parkId === undefined ? {} : { parkId }),
      }),
    );
    const reply = await answer({ question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A", text: "Hello, Ada!" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({
        question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
        delivered: "on-resume",
      });
    }
    // A budget park is not resumed by an answer: the story stays Parked, the answer is held.
    expect(w.resumed).toEqual([]);
    expect(findQuestion(w.f.office, "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A")).toMatchObject({
      closedHow: "answered",
      answer: "Hello, Ada!",
      delivered: "on-resume",
    });
    expect(heldFeedback(w.f.office, w.f.run).texts).toEqual([workerAnswerText("Hello, Ada!")]);
    expect(answersSent()).toEqual([]);
  });

  it("refuses an answer to an open question no park carries, which office load expires (one a previous daemon left)", async () => {
    w.f.office.immediate(() =>
      insertWorkerQuestion(w.f.office, {
        questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
        runId: w.f.run,
        agentId: w.f.agent,
        text: QUESTION,
        at: w.f.t.clock.now(),
      }),
    );
    const reply = await answer({ question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C", text: "Hello" });
    expect(reply).toMatchObject({ ok: false, error: { code: "question.closed" } });
    expect(answersSent()).toEqual([]);
    await loadStep();
    expect(openQuestions(w.f.office, w.f.run)).toEqual([]);
    expect(findQuestion(w.f.office, "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C")?.closedHow).toBe("expired");
  });

  it("expires a park's question once the park is resolved another way, and a later park of the story asks its own (DIPO-289 AC #10)", async () => {
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
