// Review rounds (DIPO-219; 0019 sections 4, 6 and 12), fast and local: a story that reaches In
// Review gets a pending review that the review starter starts in the reviewer place, oldest In
// Review first; a code tree key with a verdict is never reviewed again, also after a restart;
// each round started grows the budget by the review allowance; and the section 4 failure table.
// The places, run control and the review rounds are real on a migrated state database; git, the
// story read and the reviewer session start are fakes, and a "session" is an agent row that run
// control tracks, fed turns and exits as ingestion would.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type AgentId,
  type OfficeId,
  RoleId,
  type RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS } from "../../src/config";
import { reviewVerdictForTree, reviewVerdictsOf } from "../../src/review";
import {
  endRun,
  findRun,
  IN_REVIEW_END,
  insertVerifyResult,
  pendingReviews,
  Places,
  recordCodeTreeKey,
  REVIEWED_END,
  REVIEWER_ROLE,
  Reviews,
  type ReviewSessionOutcome,
  type ReviewSessionRequest,
  RunControl,
  type RunFinisher,
  type RunOutcomesPort,
  runCaps,
  runIntents,
  runSteps,
  START_KINDS,
} from "../../src/run";
import type { RunStoryFacts } from "../../src/run/resume";
import { encode } from "../../src/workers/claude-cli/encode";
import type { HostOp, ReviewReport, WorkerEvent } from "../../src/workers/types";
import { loggedEvents } from "../ingest/helpers";
import { plainTask } from "../prompts/helpers";
import {
  addAgent,
  addUsage,
  MINUTE,
  type RoundsWorld,
  roundsWorld,
  type StoryRun,
  storyRun,
} from "./rounds-helpers";

let w: RoundsWorld;

beforeEach(async () => {
  w = await roundsWorld("reviews-");
});

afterEach(() => w.close());

const now = (): number => w.t.clock.now();
const write = <T>(fn: () => T): T => w.office.immediate(fn);
const officeId = (): OfficeId => w.office.officeId as OfficeId;

const TASK_FILE = "backlog/tasks/shop-12 - Add-a-greeting.md";
const BUDGET = 1_000_000;
const ALLOWANCE = 200_000;

/** The story's diff: line 2 of src/greet.ts is new. */
const DIFF = [
  "diff --git a/src/greet.ts b/src/greet.ts",
  "index 1111111..2222222 100644",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -1 +1,2 @@",
  "-export const greeting = (name: string) => `Hi ${name}`;",
  "+export const greeting = (name: string) => `Hello, ${name}!`;",
  "+export const total = (a: number, b: number) => a - b;",
  "",
].join("\n");

const FACTS: RunStoryFacts = {
  view: plainTask(),
  fields: {
    test_plan: {
      entries: [
        { kind: "automated", check: "(unit) greet returns the greeting for a name." },
        { kind: "manual", check: "Run shop greet Ada.", expect: "It prints Hello, Ada!" },
      ],
    },
  },
  taskFile: TASK_FILE,
  dependencies: [],
};

const APPROVED: ReviewReport = {
  criteria: [
    { n: 1, status: "met", evidence: "src/greet.ts:1 prints the greeting." },
    { n: 2, status: "met", evidence: "the CLI checks the name." },
  ],
  findings: [],
  summary: "The greeting is in place.",
};

const UNMET: ReviewReport = {
  criteria: [
    { n: 1, status: "met", evidence: "src/greet.ts:1 prints the greeting." },
    { n: 2, status: "unmet", evidence: "nothing checks an empty name." },
  ],
  findings: [],
  summary: "Criterion 2 is missing.",
};

/** A blocking correctness finding at `line` of src/greet.ts, quoting line 2. */
function correctness(line: number): ReviewReport {
  return {
    ...APPROVED,
    findings: [
      {
        severity: "blocking",
        kind: "correctness",
        file: "src/greet.ts",
        line,
        quote: "export const total = (a: number, b: number) => a - b;",
        text: "total subtracts instead of adding.",
      },
    ],
    summary: "total is wrong.",
  };
}

/** A story run that worked, went green on `tree` and ended at In Review now. */
function inReview(
  story: string,
  tree: string,
  options: { reviewRoundCap?: number } = {},
): StoryRun {
  const s = storyRun(w, {
    story,
    reviewRoundCap: options.reviewRoundCap ?? 3,
    reviewMaxTurns: 60,
    reviewMaxMinutes: 30,
    reviewAllowance: ALLOWANCE,
    budgetLimit: BUDGET,
  });
  addAgent(w, s.run, "developer", false);
  green(s, tree);
  write(() => endRun(w.office, s.run, now(), IN_REVIEW_END));
  return s;
}

/** A green verify of the run on the code tree `tree`. */
function green(s: StoryRun, tree: string): void {
  write(() => {
    const loop = runSteps(w.office, s.run).filter((step) => step.kind === "loop").length;
    insertVerifyResult(w.office, s.run, {
      loop,
      profile: "branch",
      commands: [["bun", "run", "verify"]],
      exitCode: 0,
      signal: null,
      timedOut: false,
      passed: true,
      durationMs: 1,
      outputFrom: 0,
      outputTo: 0,
      at: now(),
    });
    recordCodeTreeKey(w.office, s.run, loop, tree);
  });
}

/** A fix round's In Review again (story I's part, written by hand here): a new tree, ended. */
function fixedTo(s: StoryRun, tree: string): void {
  green(s, tree);
  write(() =>
    w.office.run(
      `update runs set end_kind = $kind where office_id = $office_id and run_id = $run`,
      { run: s.run, kind: IN_REVIEW_END },
    ),
  );
  heads.set(s.run, tree);
}

/** The code tree key each run's worktree HEAD has now. */
const heads = new Map<string, string>();

interface Session {
  readonly run: RunId;
  readonly agent: AgentId;
  readonly work: WorkRef;
  readonly message: string;
}

interface World {
  readonly reviews: Reviews;
  readonly control: RunControl;
  readonly places: Places;
  readonly sessions: Session[];
  readonly sent: { run: string; ops: readonly HostOp[] }[];
  readonly warned: unknown[];
  /** The agents whose read-only copy the launcher was told to remove (DIPO-276). */
  readonly finished: string[];
  /** What the next session start answers; `started` by default. */
  next: (() => ReviewSessionOutcome) | null;
  /** The finisher's backstop parks the next turn when set. */
  backstop: string | null;
  close(): void;
}

let x: World;

function world(): World {
  const sessions: Session[] = [];
  const sent: World["sent"] = [];
  const warned: unknown[] = [];
  const finished: string[] = [];
  const state: { next: World["next"]; backstop: string | null } = { next: null, backstop: null };
  let reviews: Reviews | null = null;
  const base: RunOutcomesPort = {
    onTurnProblem: async () => undefined,
    onPlanLimit: () => undefined,
    onModelSwitched: () => undefined,
    answered: () => undefined,
    onExit: async () => undefined,
  };
  // The backstop after every turn (DIPO-49), as verify and commit runs it for a reviewer's turn.
  const finisher: RunFinisher = {
    afterTurn: async () =>
      state.backstop === null
        ? { kind: "continue" }
        : {
            kind: "park",
            reason: "scope-violation",
            cause: "backstop",
            detail: state.backstop,
            endKind: "scope-violation",
          },
    summarize: async () => undefined,
  };
  const control = new RunControl({
    clock: w.t.clock,
    offices: { get: () => w.office },
    writer: {
      write: async () => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Review",
        pushed: true,
        pushError: null,
      }),
    },
    steering: {
      send: async (_office, run, ops) => {
        sent.push({ run, ops });
        return { ok: true };
      },
    },
    encode,
    finisher,
    outcomes: () => reviews?.route(base),
  });
  const built = new Reviews({
    clock: w.t.clock,
    ids: w.t.ids,
    offices: { get: () => w.office, config: () => OFFICE_DEFAULTS },
    git: {
      head: async () => "e".repeat(40),
      codeTreeKey: async (_office, worktree) => {
        const run = findRunByWorktree(worktree);
        return heads.get(run ?? "") ?? "tree-?";
      },
      diff: async () => ({ diff: DIFF, changes: [{ path: "src/greet.ts", added: 2, removed: 1 }] }),
      sizeClass: async () => "S",
    },
    story: async () => FACTS,
    sessions: {
      start: async (request: ReviewSessionRequest) => {
        const outcome = state.next?.() ?? null;
        if (outcome !== null && outcome.kind !== "started") return outcome;
        const agent = addAgent(w, request.run.runId, REVIEWER_ROLE, true, "opus");
        const work: WorkRef = {
          story: request.run.story,
          key: request.run.key,
          run: request.run.runId,
          agent,
          role: RoleId.parse(REVIEWER_ROLE),
          tier: "M",
          model: "opus",
        } as WorkRef;
        control.track(request.office, {
          runId: request.run.runId,
          work,
          caps: { budgetTokens: BUDGET, maxTurns: 60, maxMinutes: 30 },
          startedAt: now(),
        });
        sessions.push({ run: request.run.runId, agent, work, message: request.taskMessage });
        return { kind: "started", agent };
      },
      finish: async (_office, _run, agent) => {
        finished.push(agent);
      },
    },
    steering: {
      send: async (_office, run, ops) => {
        sent.push({ run, ops });
        return { ok: true };
      },
    },
    encode,
    ender: () => control,
    adapter: OFFICE_DEFAULTS.worker.adapter,
    holds: {
      hold: (adapter, failures) => ({
        adapter,
        check: failures[0]?.check ?? "",
        detail: failures[0]?.detail ?? "",
        failures,
        since: now(),
      }),
    },
    warn: (message, fields) => warned.push({ message, fields }),
  });
  reviews = built;
  // As `composeRuns` wires them: pending reviews and the review starter in the reviewer place.
  const places = new Places({
    clock: w.t.clock,
    offices: { get: () => w.office, config: () => OFFICE_DEFAULTS },
    pending: (office) => built.pending(office),
    starters: { review: (office, run, start) => built.start(office, run, start) },
  });
  const result: World = {
    reviews: built,
    control,
    places,
    sessions,
    sent,
    warned,
    finished,
    get next() {
      return state.next;
    },
    set next(value) {
      state.next = value;
    },
    get backstop() {
      return state.backstop;
    },
    set backstop(value) {
      state.backstop = value;
    },
    close: () => {
      places.close();
      control.close();
    },
  };
  return result;
}

function findRunByWorktree(worktree: string): string | null {
  return (
    w.office.get<{ run_id: string }>(
      "select run_id from runs where office_id = $office_id and worktree = $worktree",
      { worktree },
    )?.run_id ?? null
  );
}

beforeEach(() => {
  heads.clear();
  x = world();
});

afterEach(() => x.close());

/** The reviewer session's turn with `review` as its valid report, through run control. */
async function turn(session: Session, review: ReviewReport): Promise<void> {
  const event: WorkerEvent = {
    t: "turn",
    report: null,
    review,
    totals: {},
    numTurns: 1,
    terminal: "success",
  };
  x.control.onWorkerEvents(session.run, [event]);
  await x.control.idle();
}

/** A reviewer turn that ended with a problem, through run control. */
async function problem(session: Session, kind: "report" | "error", detail: string): Promise<void> {
  x.control.onWorkerEvents(session.run, [
    {
      t: "turn",
      report: null,
      totals: {},
      numTurns: 1,
      terminal: "success",
      problem: { kind, detail },
    },
  ]);
  await x.control.idle();
}

/** The reviewer session exits with `code`, as ingestion reports it. */
async function exits(session: Session, code = 0): Promise<void> {
  w.office.immediate(() =>
    w.office.run(
      `update agents set ended_at = $at, end_reason = coalesce(end_reason, 'exited')
        where office_id = $office_id and agent_id = $agent`,
      { at: now(), agent: session.agent },
    ),
  );
  x.control.onEnded(session.run, session.agent, {
    exit: { code, signal: null },
    state: {} as never,
  });
  await x.control.idle();
}

const parksOf = () =>
  w.office.all<{ story_id: string; reason: string; cause: string; detail: string }>(
    "select story_id, reason, cause, detail from parks where office_id = $office_id order by park_id",
  );

const stepsOf = (run: RunId, kind: string) =>
  runSteps(w.office, run).filter((step) => step.kind === kind);

/** The texts the steering sent to the run as user messages. */
function steered(run: RunId): string[] {
  return x.sent
    .filter((send) => send.run === run)
    .flatMap((send) => send.ops)
    .flatMap((op) =>
      "write" in op
        ? [(JSON.parse(op.write) as { message: { content: string } }).message.content]
        : [],
    );
}

/** The logged events of `type`. */
const events = (type: string) => loggedEvents(w.office).filter((event) => event.type === type);

/** Starts the review of the In Review story `s` through the places; its session. */
async function reviewStarts(s: StoryRun): Promise<Session> {
  await x.places.drain(officeId());
  const session = x.sessions.findLast((started) => started.run === s.run);
  if (session === undefined) throw new Error(`no review of ${s.story} started`);
  return session;
}

describe("a pending review (0019 sections 6 and 12)", () => {
  it("starts once the reviewer place is free, oldest In Review first, and stores its verdict by code tree key", async () => {
    // Another story's review holds the reviewer place.
    const busy = storyRun(w, { story: "DIPO-7", reviewRoundCap: 3 });
    write(() =>
      w.office.run(
        `insert into run_steps (office_id, run_id, step, kind, value, at)
         values ($office_id, $run, 1, 'phase', 'review', $at)`,
        { run: busy.run, at: now() },
      ),
    );
    const holder = addAgent(w, busy.run, REVIEWER_ROLE, true, "opus");
    const older = inReview("DIPO-1", "tree-1");
    heads.set(older.run, "tree-1");
    const olderAt = now();
    w.t.clock.advance(5 * MINUTE);
    const newer = inReview("DIPO-2", "tree-2");
    heads.set(newer.run, "tree-2");

    expect(pendingReviews(w.office)).toEqual([
      { kind: START_KINDS.review, runId: older.run, since: olderAt },
      { kind: START_KINDS.review, runId: newer.run, since: now() },
    ]);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toEqual([]);

    // The place frees; ten minutes after the older story reached In Review its review starts.
    w.office.immediate(() =>
      w.office.run(
        "update agents set ended_at = $at where office_id = $office_id and agent_id = $agent",
        { at: now(), agent: holder },
      ),
    );
    write(() => endRun(w.office, busy.run, now(), "reviewed"));
    w.t.clock.advance(5 * MINUTE);
    const reopenedAt = now();
    const session = await reviewStarts(older);
    expect(x.sessions.map((started) => started.run)).toEqual([older.run]);
    // The reopen and its review phase step keep their own time; the wait was the In Review time.
    expect(findRun(w.office, older.run)).toMatchObject({ endedAt: null, waiting: null });
    expect(stepsOf(older.run, "phase").at(-1)).toMatchObject({ value: "review", at: reopenedAt });
    expect(session.message).toContain("<diff>");
    expect(session.message).toContain("src/greet.ts (+2 -1)");

    await turn(session, APPROVED);
    const verdict = reviewVerdictForTree(w.office, older.run, "tree-1");
    expect(verdict).toMatchObject({
      round: 1,
      verdict: "approved",
      commit: "e".repeat(40),
      codeTreeKey: "tree-1",
      agent: session.agent,
    });
    expect(findRun(w.office, older.run)).toMatchObject({ endKind: REVIEWED_END });
    expect(events("gate.decided")).toHaveLength(1);
    // The verdict explains the exit: stdin closes with no intent.
    expect(x.sent.at(-1)).toEqual({ run: older.run, ops: [{ closeStdin: true }] });
    expect(runIntents(w.office, older.run)).toEqual([]);
    await exits(session);
    expect(parksOf()).toEqual([]);
    // The round's read-only copy goes with the session's exit (DIPO-276).
    expect(x.finished).toEqual([session.agent]);

    // The newer story's review starts next.
    await reviewStarts(newer);
    expect(x.sessions.map((started) => started.run)).toEqual([older.run, newer.run]);
  });

  it("waits again from its In Review time when its session does not start", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const inReviewAt = now();
    w.t.clock.advance(3 * MINUTE);
    x.next = () => ({ kind: "failed", reason: "the host did not start" });
    expect(await x.places.drain(officeId())).toBe(0);
    // Reopened for its review at the start time, it waits for the place from the In Review time.
    expect(findRun(w.office, s.run)).toMatchObject({
      endedAt: null,
      waiting: START_KINDS.review,
      waitingSince: inReviewAt,
    });
    expect(stepsOf(s.run, "phase").at(-1)).toMatchObject({ value: "review", at: now() });
    expect(pendingReviews(w.office)).toEqual([]);

    // The next drain starts it, in the same round.
    x.next = null;
    w.t.clock.advance(MINUTE);
    await reviewStarts(s);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
  });

  it("passes the previous round's findings to a re-review", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const first = await reviewStarts(s);
    expect(first.message).not.toContain("<previous_findings>");
    await turn(first, correctness(2));
    await exits(first);
    fixedTo(s, "tree-2");
    const second = await reviewStarts(s);
    expect(second.message).toContain("<previous_findings>");
    expect(second.message).toContain("total subtracts instead of adding.");
  });
});

describe("a code tree key with a verdict (0019 section 6)", () => {
  it("is not reviewed again after a daemon restart", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await turn(session, APPROVED);
    await exits(session);

    // A restart: new services over the same state; the In Review run ends again on the same
    // tree (a park and resume commit only the task file).
    x.close();
    x = world();
    write(() =>
      w.office.run(
        `update runs set end_kind = $kind where office_id = $office_id and run_id = $run`,
        { run: s.run, kind: IN_REVIEW_END },
      ),
    );
    expect(pendingReviews(w.office)).toEqual([]);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toEqual([]);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
  });

  it("is taken without a round by a head whose commits changed only the task file", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await turn(session, APPROVED);
    await exits(session);

    // The verify recorded no tree for the new In Review head, so it looks pending; its HEAD's code
    // tree, read at the start, is the reviewed one.
    write(() => {
      w.office.run(
        `update verify_results set code_tree_key = null where office_id = $office_id and run_id = $run`,
        { run: s.run },
      );
      w.office.run(
        `update runs set end_kind = $kind where office_id = $office_id and run_id = $run`,
        { run: s.run, kind: IN_REVIEW_END },
      );
    });
    expect(pendingReviews(w.office)).toHaveLength(1);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toHaveLength(1);
    expect(findRun(w.office, s.run)).toMatchObject({ endKind: REVIEWED_END });
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(pendingReviews(w.office)).toEqual([]);
  });
});

describe("the review allowance (0019 section 4)", () => {
  it("grows the budget limit per round started and adds nothing for a retried session", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET);

    const first = await reviewStarts(s);
    const rounds = stepsOf(s.run, "review");
    expect(rounds).toHaveLength(1);
    expect(JSON.parse(rounds[0]?.value ?? "")).toMatchObject({ round: 1, allowance: ALLOWANCE });
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET + ALLOWANCE);

    // The session crashes: one fresh session for the same round, which adds nothing.
    await exits(first, 1);
    expect(x.sessions).toHaveLength(2);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET + ALLOWANCE);

    // A blocked verdict, a fix and a second round: the budget grows again.
    await turn(x.sessions[1]!, UNMET);
    await exits(x.sessions[1]!);
    fixedTo(s, "tree-2");
    await reviewStarts(s);
    expect(stepsOf(s.run, "review").map((step) => JSON.parse(step.value).round)).toEqual([1, 2]);
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET + 2 * ALLOWANCE);
  });
});

describe("the failure table (0019 section 4)", () => {
  it("parks review-blocked with cause rounds at the third failed round, a review-failed row per failed round", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    for (const [round, tree] of [
      [1, "tree-1"],
      [2, "tree-2"],
    ] as const) {
      if (round > 1) fixedTo(s, tree);
      const session = await reviewStarts(s);
      await turn(session, UNMET);
      await exits(session);
      expect(findRun(w.office, s.run)).toMatchObject({ endKind: REVIEWED_END });
      expect(stepsOf(s.run, "review-failed")).toHaveLength(round);
      expect(parksOf()).toEqual([]);
    }
    fixedTo(s, "tree-3");
    const third = await reviewStarts(s);
    await turn(third, correctness(2));
    expect(stepsOf(s.run, "review-failed").map((step) => step.value)).toEqual(["1", "2", "3"]);
    const parks = parksOf();
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({ reason: "review-blocked", cause: "rounds" });
    expect(parks[0]?.detail).toContain("the 3 of 3 failed rounds");
    expect(parks[0]?.detail).toContain(
      "- blocking correctness at src/greet.ts:2: total subtracts instead of adding.",
    );
    expect(reviewVerdictsOf(w.office, s.key).map((verdict) => verdict.verdict)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
  });

  it("gives an invalid report one correction turn, then ends the session as a crash; a second crash parks worker-failed with cause review", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const first = await reviewStarts(s);
    const missing: ReviewReport = { ...APPROVED, criteria: [APPROVED.criteria[0]!] };
    await turn(first, missing);
    expect(steered(s.run).join("\n")).toContain("without a valid review report");
    expect(steered(s.run).join("\n")).toContain("criteria has no entry for criterion #2");
    expect(reviewVerdictsOf(w.office, s.key)).toEqual([]);

    // Still invalid after the correction turn: as a crash, one fresh session for the same round.
    await turn(first, missing);
    expect(runIntents(w.office, s.run).at(-1)).toMatchObject({ kind: "stop" });
    await exits(first, 143);
    expect(x.sessions).toHaveLength(2);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(JSON.stringify(events("engine.notice"))).toContain("review.failed");

    // The fresh session crashes too: worker-failed, cause review, with its last error.
    await exits(x.sessions[1]!, 1);
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "worker-failed",
        cause: "review",
        detail: "the reviewer failed twice in review round 1: the reviewer exited with code 1",
      },
    ]);
    expect(stepsOf(s.run, "review-failed")).toEqual([]);
  });

  it("gives a report whose blocking evidence fails one correction turn naming the findings, then keeps them advisory and unverified", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await turn(session, correctness(7));
    const text = steered(s.run).join("\n");
    expect(text).toContain("did not check out");
    expect(text).toContain(
      "finding 1 (correctness): line 7 of src/greet.ts is not inside a hunk of the story's diff",
    );
    expect(reviewVerdictsOf(w.office, s.key)).toEqual([]);

    await turn(session, correctness(7));
    const [verdict] = reviewVerdictsOf(w.office, s.key);
    expect(verdict?.verdict).toBe("approved");
    expect(verdict?.findings).toEqual([
      expect.objectContaining({ severity: "advisory", kind: "correctness", unverified: true }),
    ]);
    expect(stepsOf(s.run, "review-failed")).toEqual([]);
  });

  it("parks worker-failed with cause review-cap at the reviewer's own turn cap, naming the cap", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    // The developer's turn cap of 100 is not the reviewer's; 60 is.
    addUsage(w, s.run, session.agent, REVIEWER_ROLE, { turns: 60, tokens: 1_000 });
    expect(x.control.checkCaps(s.run)).toBe(true);
    await x.control.idle();
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "worker-failed",
        cause: "review-cap",
        detail: "the reviewer's turn cap reached: 60 of 60 turns",
      },
    ]);
    await exits(session);
    expect(x.sessions).toHaveLength(1);
  });

  it("parks budget-exceeded with cause review when the story's budget runs out in a review", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    addUsage(w, s.run, session.agent, REVIEWER_ROLE, { turns: 3, tokens: BUDGET + ALLOWANCE });
    expect(x.control.checkCaps(s.run)).toBe(true);
    await x.control.idle();
    expect(parksOf()).toEqual([
      expect.objectContaining({ reason: "budget-exceeded", cause: "review" }),
    ]);
  });

  it("parks scope-violation with cause backstop when the review changed the worktree", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    x.backstop = "HEAD moved: e1 to f2";
    await turn(session, APPROVED);
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "scope-violation",
        cause: "backstop",
        detail: "HEAD moved: e1 to f2",
      },
    ]);
    expect(reviewVerdictsOf(w.office, s.key)).toEqual([]);
  });

  it("stops the session at a plan limit, never parks, and waits for a fresh review from the In Review time", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const inReviewAt = now();
    w.t.clock.advance(MINUTE);
    const session = await reviewStarts(s);
    x.control.onWorkerEvents(s.run, [{ t: "limit", status: "rejected", scope: "session" }]);
    await x.control.idle();
    expect(runIntents(w.office, s.run).at(-1)).toMatchObject({ kind: "stop" });
    await exits(session, 0);
    expect(parksOf()).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({
      endedAt: null,
      waiting: START_KINDS.review,
      waitingSince: inReviewAt,
    });
    // After the reset a fresh session starts in the same round.
    await reviewStarts(s);
    expect(x.sessions).toHaveLength(2);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
  });

  it("keeps the story In Review with a notice when the reviewer's launch check is refused, and the review waits", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    w.t.clock.advance(MINUTE);
    x.next = () => ({
      kind: "startFailed",
      hold: {
        adapter: "claude-cli",
        check: "self-test",
        detail: "the control write was refused",
        failures: [{ check: "self-test", detail: "the control write was refused" }],
        since: now(),
      },
    });
    expect(await x.places.drain(officeId())).toBe(0);
    expect(parksOf()).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: START_KINDS.review });
    const notices = JSON.stringify(events("engine.notice"));
    expect(notices).toContain("run.startFailed");
    expect(notices).toContain("stays In Review and its review waits");
  });

  it("ends a session whose turn failed as a crash and starts one fresh session", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await problem(session, "error", "API Error: 500");
    await exits(session, 1);
    expect(x.sessions).toHaveLength(2);
    // The crashed session's read-only copy goes; the fresh session has its own (DIPO-276).
    expect(x.finished).toEqual([session.agent]);
    expect(parksOf()).toEqual([]);
    expect(
      w.office.get<{ end_reason: string }>(
        "select end_reason from agents where office_id = $office_id and agent_id = $agent",
        { agent: session.agent },
      )?.end_reason,
    ).toBe("review-crashed");
  });
});
