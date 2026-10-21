// The question of a worker's report through the live-question rule (DIPO-272 AC #5, 0021 section
// 11, DIPO-279 and DIPO-284): run control and the permission wait wired as `composeRuns` wires them,
// on a migrated state database with one claimed story run, a fake park writer and a steering fake.
// A question is live only while a TUI is connected; otherwise, and once the last TUI closes, the
// story parks `ambiguous-spec` with the question.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { OFFICE_DEFAULTS } from "../../src/config";
import { PermissionAsks, workerAnswerText } from "../../src/hooks/permissions";
import { findQuestion, openQuestions } from "../../src/hooks/questions";
import { type BranchPark, insertRun, RunControl } from "../../src/run";
import { heldMessages } from "../../src/run/pauses";
import { activeSignals } from "../../src/run/signals";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps, HostOp, WorkerEvent } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture, loggedEvents } from "../ingest/helpers";
import { SCRIPTS } from "../workers/scripts";

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const QUESTION = "Which greeting should the CLI print?";

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly asks: PermissionAsks;
  readonly sent: HostOp[][];
  readonly work: WorkRef;
  /** Whether a TUI is connected, read at the moment of each question. */
  tui: boolean;
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "worker-question-"));
  const f = await ingestFixture(dir);
  const sent: HostOp[][] = [];
  const world = { dir, f, sent, tui: true } as unknown as World;
  const steering = {
    send: async (_office: unknown, _run: unknown, ops: readonly HostOp[]) => {
      sent.push([...ops]);
      return { ok: true } as const;
    },
  };
  let asks: PermissionAsks | null = null;
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
    questions: () => asks ?? undefined,
  });
  asks = new PermissionAsks({
    clock: f.t.clock,
    ids: f.t.ids,
    offices: { get: () => f.office, config: () => OFFICE_DEFAULTS },
    steering,
    encode,
    presence: { tuiConnected: () => world.tui },
    ending: (run) => control.isEnding(run),
    parkQuestion: (_office, run, question) => {
      control.parkOnQuestion(run, question);
    },
  });
  (world as { control: RunControl }).control = control;
  (world as { asks: PermissionAsks }).asks = asks;
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
    // The session's agent, which ingestion records from the worker's start.
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', 0)`,
      { agent: f.agent, run },
    );
  });
  control.track(office.officeId, {
    runId: run,
    work: world.work,
    caps: ROOMY,
    startedAt: f.t.clock.now(),
  });
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

/** The worker's blocked report with a question, as one ingestion pass hands it to run control. */
async function blockedQuestion(): Promise<void> {
  w.control.onWorkerEvents(w.f.run, SCRIPTS["blocked-question"] as WorkerEvent[], w.f.agent);
  await w.control.idle();
}

function parks(): { reason: string; cause: string | null; detail: string }[] {
  return w.f.office.all(
    "select reason, cause, detail from parks where office_id = $office_id order by rowid",
  );
}

function types(): string[] {
  return loggedEvents(w.f.office).map((event) => event.type);
}

let requests = 0;
function answer(args: Record<string, unknown>): Promise<CommandReply> {
  requests += 1;
  return executeCommand(
    {
      registry: buildRegistry([w.asks.feature]),
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

describe("a worker's question with a TUI connected (criterion 5)", () => {
  it("is asked live: a question is stored, question.asked and input-wait are emitted, and nothing parks", async () => {
    await blockedQuestion();
    expect(parks()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.control.isEnding(w.f.run)).toBe(false);
    const [question] = openQuestions(w.f.office, w.f.run);
    expect(question).toMatchObject({ kind: "question", text: QUESTION, hook: null, parkId: null });
    expect(types()).toContain("question.asked");
    expect(activeSignals(w.f.office, w.f.run).map((signal) => signal.signal)).toEqual([
      "input-wait",
    ]);
  });

  it("sends the answer text to the waiting worker as its next message and closes the question", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    const reply = await answer({ question: question?.questionId, text: "  Hello, Ada!  " });
    expect(reply.ok).toBe(true);
    if (reply.ok)
      expect(reply.result).toEqual({ question: question?.questionId, delivered: "now" });
    expect(w.sent).toEqual([encode({ kind: "answer", text: workerAnswerText("Hello, Ada!") })]);
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedHow: "answered",
      answer: "Hello, Ada!",
      decision: null,
    });
    expect(activeSignals(w.f.office, w.f.run)).toEqual([]);
    expect(parks()).toEqual([]);
    // Answered once: a second answer finds nothing waiting.
    const again = await answer({ question: question?.questionId, text: "Hi" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("question.closed");
  });

  it("refuses an answer with a decision or without text, and keeps waiting", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    for (const args of [
      { question: question?.questionId, text: "yes", decision: "allow" },
      { question: question?.questionId, text: "   " },
    ]) {
      const reply = await answer(args);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("args.invalid");
    }
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    expect(w.sent).toEqual([]);
  });

  it("parks the story with the question at once when the last TUI closes while it waits (DIPO-284)", async () => {
    await blockedQuestion();
    const [question] = openQuestions(w.f.office, w.f.run);
    // Another TUI still open: nothing changes.
    w.asks.presenceChanged();
    expect(openQuestions(w.f.office, w.f.run)).toHaveLength(1);
    w.tui = false;
    w.asks.presenceChanged();
    await w.control.idle();
    expect(findQuestion(w.f.office, question?.questionId ?? "")?.closedHow).toBe("ended");
    expect(parks()).toEqual([{ reason: "ambiguous-spec", cause: "question", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    const late = await answer({ question: question?.questionId, text: "Hello" });
    expect(late.ok).toBe(false);
  });
});

describe("a worker's question when its run ends while it waits (DIPO-272)", () => {
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
    const park = w.f.office.get<{ park_id: number }>(
      "select park_id from parks where office_id = $office_id",
    );
    expect(parked?.parkId).toBe(park?.park_id ?? -1);
    expect(parks()).toHaveLength(1);

    const reply = await answer({ question: question?.questionId, text: "Hello, Ada!" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ question: question?.questionId, delivered: "on-resume" });
    }
    expect(findQuestion(w.f.office, question?.questionId ?? "")).toMatchObject({
      closedHow: "answered",
      answer: "Hello, Ada!",
    });
    expect(heldMessages(w.f.office, w.f.run, (text) => text).texts).toEqual([
      workerAnswerText("Hello, Ada!"),
    ]);
  });
});

describe("a worker's question without a TUI (criterion 5)", () => {
  it("parks the story ambiguous-spec with the question at once and stores no live question", async () => {
    w.tui = false;
    await blockedQuestion();
    expect(parks()).toEqual([{ reason: "ambiguous-spec", cause: "question", detail: QUESTION }]);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    expect(openQuestions(w.f.office, w.f.run)).toEqual([]);
    expect(types()).not.toContain("question.asked");
  });

  it("parks a blocked report without a question with its reason, whatever the TUI", async () => {
    const [started, turn] = SCRIPTS["blocked-question"] as WorkerEvent[];
    if (turn?.t !== "turn" || turn.report === null) throw new Error("fixture changed");
    const { question: _question, ...report } = turn.report;
    w.control.onWorkerEvents(
      w.f.run,
      [started as WorkerEvent, { ...turn, report: { ...report, summary: "The box has no jq." } }],
      w.f.agent,
    );
    await w.control.idle();
    expect(parks()).toEqual([
      { reason: "ambiguous-spec", cause: "question", detail: "The box has no jq." },
    ]);
    expect(openQuestions(w.f.office, w.f.run)).toEqual([]);
  });
});
