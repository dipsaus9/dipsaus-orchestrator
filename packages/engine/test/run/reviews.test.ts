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

import { mirrorUnpark } from "../../src/run/park-state";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { reviewVerdictForTree, reviewVerdictsOf } from "../../src/review";
import {
  DONE_END,
  endRun,
  findRun,
  IN_REVIEW_END,
  LAUNCH_NOTICES,
  openPark,
  pendingReviews,
  placeHolders,
  Places,
  planRefusedText,
  recordConfigSnapshot,
  REVIEWED_END,
  REVIEW_NOTICES,
  REVIEWER_ROLE,
  resolvePark,
  reviewerSettings,
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
  waitingStarts,
} from "../../src/run";
import { parkStory } from "../../src/run/park";
import { storeDoneReport } from "../../src/run/report-data";
import { appendEntries } from "../../src/changelog/log";
import type { RunStoryFacts } from "../../src/run/resume";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type HostOp,
  PlanError,
  type ReviewReport,
  type WorkerEvent,
} from "../../src/workers/types";
import { updateClaim } from "../../src/worktree/records";
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
/** The reviewer's own token cap per session (0002). */
const REVIEW_TOKENS = 200_000;

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

/** A story run that worked, whose HEAD is on the code tree `tree`, ended at In Review now. */
function inReview(
  story: string,
  tree: string,
  options: { reviewRoundCap?: number; reviewCaps?: boolean } = {},
): StoryRun {
  const s = storyRun(w, {
    story,
    reviewRoundCap: options.reviewRoundCap ?? 3,
    // A run started before the reviewer's caps were kept has none in its snapshot.
    reviewMaxTurns: options.reviewCaps === false ? null : 60,
    reviewMaxMinutes: options.reviewCaps === false ? null : 30,
    reviewMaxTokens: REVIEW_TOKENS,
    budgetLimit: BUDGET,
  });
  addAgent(w, s.run, "developer", false);
  write(() => {
    endRun(w.office, s.run, now(), IN_REVIEW_END);
    // The In Review push reached the remote, at the run's end: the review may start (DIPO-315).
    updateClaim(w.office, s.run, { pushedAt: now() });
  });
  heads.set(s.run, tree);
  return s;
}

/** A fix round's In Review again (story I's part, written by hand here): a new tree, ended. */
function fixedTo(s: StoryRun, tree: string): void {
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

/** The story facts the base read gives and the office configuration in force; reset per test. */
const setting: { facts: RunStoryFacts; config: OfficeConfig } = {
  facts: FACTS,
  config: OFFICE_DEFAULTS,
};

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
  /** What `onReviewed` heard: `<run> <agent or ->`. */
  readonly reviewedRuns: string[];
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
  const reviewedRuns: string[] = [];
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
    offices: { get: () => w.office, config: () => setting.config },
    git: {
      head: async () => "e".repeat(40),
      codeTreeKey: async (_office, worktree) => {
        const run = findRunByWorktree(worktree);
        return heads.get(run ?? "") ?? "tree-?";
      },
      diff: async () => ({ diff: DIFF, changes: [{ path: "src/greet.ts", added: 2, removed: 1 }] }),
      sizeClass: async () => "S",
    },
    story: async () => setting.facts,
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
    onReviewed: (_office, run, agent) => reviewedRuns.push(`${run} ${agent ?? "-"}`),
  });
  reviews = built;
  // As `composeRuns` wires them: pending reviews and the review starter in the reviewer place.
  const places = new Places({
    clock: w.t.clock,
    offices: { get: () => w.office },
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
    reviewedRuns,
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
  setting.facts = FACTS;
  setting.config = OFFICE_DEFAULTS;
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
  w.office.all<{ story_id: string; reason: string; detail: string }>(
    "select story_id, reason, detail from parks where office_id = $office_id order by park_id",
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

  it("tells the maintainer once when the reviewer's copy does not match the head, and the review waits (DIPO-276)", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const why =
      "the read-only copy of the pushed commit could not be made: the copy of eee does not match the commit: 1 of its files missing, 0 files it does not hold";
    w.t.clock.advance(3 * MINUTE);
    x.next = () => ({ kind: "failed", reason: why, copyMismatch: true });
    expect(await x.places.drain(officeId())).toBe(0);
    // The story stays In Review and its review waits for the place again.
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: START_KINDS.review });
    w.t.clock.advance(MINUTE);
    expect(await x.places.drain(officeId())).toBe(0);
    const notices = events("engine.notice").filter((event) =>
      JSON.stringify(event).includes("review.copyMismatch"),
    );
    expect(notices).toHaveLength(1);
    const text = JSON.stringify(notices[0]);
    expect(text).toContain("DIPO-1: the review cannot start");
    expect(text).toContain("differ only in case");
    expect(text).toContain('"level":"warn"');
    // A plain failure raises no such notice.
    x.next = () => ({ kind: "failed", reason: "the host did not start" });
    w.t.clock.advance(MINUTE);
    await x.places.drain(officeId());
    expect(
      events("engine.notice").filter((event) =>
        JSON.stringify(event).includes("review.copyMismatch"),
      ),
    ).toHaveLength(1);
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

  it("gives the reviewer the test-plan statuses and deviations of the worker's last done report (DIPO-254)", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    w.office.immediate(() => {
      storeDoneReport(w.office, s.run, {
        testPlan: [{ n: 1, status: "not-done", evidence: "an older report" }],
        at: now(),
      });
      storeDoneReport(w.office, s.run, {
        testPlan: [{ n: 1, status: "done", evidence: "test/greet.test.ts: greets" }],
        deviations: [{ where: "criterion #1", what: "prints Hi", why: "the style guide" }],
        at: now(),
      });
    });
    const session = await reviewStarts(s);
    expect(session.message).toContain(
      "<worker_report>\nWhat the worker reported with its last done",
    );
    expect(session.message).toContain("- #1 done: test/greet.test.ts: greets");
    expect(session.message).toContain("- criterion #1: prints Hi Why: the style guide");
    expect(session.message).not.toContain("an older report");
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
    // It looks pending (dipo records no tree at In Review), and the drain takes its verdict: its
    // HEAD's code tree, read at the start, is the reviewed one.
    expect(pendingReviews(w.office)).toHaveLength(1);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toEqual([]);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(pendingReviews(w.office)).toEqual([]);
  });

  it("is taken without a round by a head whose commits changed only the task file", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await turn(session, APPROVED);
    await exits(session);

    // dipo records no tree for the new In Review head, so it looks pending; its HEAD's code tree,
    // read at the start, is the reviewed one.
    write(() => {
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

describe("review rounds grow no cap (0002, 0020)", () => {
  it("leaves the story's budget as it started for every round and every retried session", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET);

    const first = await reviewStarts(s);
    const rounds = stepsOf(s.run, "review");
    expect(rounds).toHaveLength(1);
    expect(JSON.parse(rounds[0]?.value ?? "")).toEqual({ round: 1, since: expect.any(Number) });
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET);

    // The session crashes: one fresh session for the same round, which adds nothing.
    await exits(first, 1);
    expect(x.sessions).toHaveLength(2);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET);

    // A blocked verdict, a fix and a second round: the budget still stands where it started.
    await turn(x.sessions[1]!, UNMET);
    await exits(x.sessions[1]!);
    fixedTo(s, "tree-2");
    await reviewStarts(s);
    expect(stepsOf(s.run, "review").map((step) => JSON.parse(step.value).round)).toEqual([1, 2]);
    expect(runCaps(w.office, findRun(w.office, s.run)!).budgetTokens).toBe(BUDGET);
  });
});

describe("the failure table (0019 section 4)", () => {
  it("parks review-blocked at the third failed round, a review-failed row per failed round", async () => {
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
    expect(parks[0]).toMatchObject({ reason: "review-blocked" });
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

  it("gives an invalid report one correction turn, then ends the session as a crash; a second crash parks worker-failed", async () => {
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

    // The fresh session crashes too: worker-failed, with its last error.
    await exits(x.sessions[1]!, 1);
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "worker-failed",
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

  it("parks worker-failed at the reviewer's own turn cap, naming the cap", async () => {
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
        detail: "the reviewer's turn cap reached: 60 of 60 turns",
      },
    ]);
    await exits(session);
    expect(x.sessions).toHaveLength(1);
  });

  it("counts the review against the reviewer's own token cap, never the story's budget", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const developer = w.office.get<{ agent_id: string }>(
      `select agent_id from agents where office_id = $office_id and run_id = $run
        and role = 'developer'`,
      { run: s.run },
    )?.agent_id as AgentId;
    // The developer used all but one token of the story's budget before In Review.
    addUsage(w, s.run, developer, "developer", { turns: 3, tokens: BUDGET - 1 });
    const session = await reviewStarts(s);
    // The review alone takes the story past its budget, but stays under its own cap.
    addUsage(w, s.run, session.agent, REVIEWER_ROLE, { turns: 3, tokens: REVIEW_TOKENS - 1 });
    expect(x.control.checkCaps(s.run)).toBe(false);
    expect(parksOf()).toEqual([]);
  });

  it("parks worker-failed at the reviewer's own token cap, naming the cap", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    addUsage(w, s.run, session.agent, REVIEWER_ROLE, { turns: 3, tokens: REVIEW_TOKENS });
    expect(x.control.checkCaps(s.run)).toBe(true);
    await x.control.idle();
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "worker-failed",
        detail:
          "the reviewer's token budget reached: 200,000 of 200,000 budget tokens (input, output and cache creation)",
      },
    ]);
  });

  it("parks scope-violation when the review changed the worktree", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    x.backstop = "HEAD moved: e1 to f2";
    await turn(session, APPROVED);
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "scope-violation",
        detail: "HEAD moved: e1 to f2",
      },
    ]);
    expect(reviewVerdictsOf(w.office, s.key)).toEqual([]);
  });

  it("parks worker-failed at a plan limit, to resume by itself when the office's starts paused lifts (0020)", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    w.t.clock.advance(MINUTE);
    const session = await reviewStarts(s);
    const reset = new Date(now() + 3_600_000).toISOString();
    x.control.onWorkerEvents(s.run, [{ t: "limit", status: "rejected", resetsAt: reset }]);
    await x.control.idle();
    await exits(session, 0);
    expect(parksOf()).toEqual([
      { story_id: "DIPO-1", reason: "worker-failed", detail: `plan limit until ${reset}` },
    ]);
    expect(
      w.office.get<{ resume_on_lift: number }>(
        "select resume_on_lift from parks where office_id = $office_id",
      )?.resume_on_lift,
    ).toBe(1);
    expect(findRun(w.office, s.run)).toMatchObject({ endKind: "plan-limit", waiting: null });
    expect(findRun(w.office, s.run)?.endedAt).not.toBeNull();
    expect(x.sessions).toHaveLength(1);
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

  it("removes a session's read-only copy when its host is found lost, then starts one fresh session", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    x.control.onHostLost(session.run, session.agent);
    await x.control.idle();
    expect(x.finished).toEqual([session.agent]);
    expect(x.sessions).toHaveLength(2);
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

/** The story facts as the office base reads them, with `status`. */
const onBase = (status: string): RunStoryFacts => ({ ...FACTS, view: plainTask({ status }) });

/** The engine notices of `code`. */
const noticesOf = (code: string) =>
  events("engine.notice").filter((event) => JSON.stringify(event).includes(`"${code}"`));

/** True when the run's claim is still live. */
const claimLive = (run: RunId): boolean =>
  w.office.get(
    "select 1 as found from claims where office_id = $office_id and run_id = $run and released_at is null",
    { run },
  ) !== null;

/** `story.park` of the story as the planning lane hands it to run control. */
const parkIt = (s: StoryRun) =>
  x.control.parkByMaintainer(
    {
      office: w.office,
      stories: { get: () => ({ story: s.story, key: s.key }) },
      commit: (fn: () => unknown) => write(() => void fn()),
    } as unknown as AsyncCommandContext,
    { story: s.story, note: "After the release." },
  );

describe("a story parked while it waits In Review (DIPO-344)", () => {
  it("gets no review round or reviewer session until its park is resolved, then its review starts", async () => {
    const s = inReview("DIPO-1", "tree-1");
    const start = pendingReviews(w.office)[0]!;
    await parkIt(s);
    expect(parksOf()).toEqual([
      { story_id: "DIPO-1", reason: "by-maintainer", detail: "After the release." },
    ]);

    expect(pendingReviews(w.office)).toEqual([]);
    expect(await x.places.drain(officeId())).toBe(0);
    // A start queued before the park waits too.
    expect(await x.reviews.start(officeId(), findRun(w.office, s.run)!, start)).toBe(false);
    expect(x.sessions).toEqual([]);
    expect(stepsOf(s.run, "review")).toEqual([]);

    // The resume resolves the park (`ParkResumes`); the next drain starts the review.
    const parkId = openPark(w.office, s.key)!.parkId;
    write(() => {
      resolvePark(w.office, parkId, "resume", now());
      // The lift's read-back: In Review with no park record in Backlog.md (DIPO-360).
      mirrorUnpark(w.office, s.key, "In Review");
    });
    const session = await reviewStarts(s);
    expect(session.run).toBe(s.run);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
  });
});

describe("a story whose park could not be written to Backlog.md (DIPO-360)", () => {
  it("gets no review round or reviewer session while its park row is open, fail-closed", async () => {
    const s = inReview("DIPO-1", "tree-1");
    const start = pendingReviews(w.office)[0]!;
    await parkStory(
      {
        office: w.office,
        writer: {
          write: async () => {
            throw new Error("the push was refused");
          },
        },
        now,
        write: (fn) => write(() => void appendEntries(w.office, fn(), { at: now() })),
        implemented: () => true,
      },
      {
        run: findRun(w.office, s.run)!,
        reason: "review-blocked",
        detail: "blocked",
        endKind: "review-blocked",
      },
    );
    // Backlog.md does not hold the park, and the run keeps its In Review end kind.
    expect(openPark(w.office, s.key)).toBeNull();
    expect(findRun(w.office, s.run)?.endKind).toBe(IN_REVIEW_END);
    expect(pendingReviews(w.office)).toEqual([]);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(await x.reviews.start(officeId(), findRun(w.office, s.run)!, start)).toBe(false);
    expect(x.sessions).toEqual([]);
  });
});

describe("a story Done on the office base (DIPO-239)", () => {
  it("gets no review round or session for a run ended at In Review, which ends done once", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    setting.facts = onBase("Done");
    const run = findRun(w.office, s.run)!;
    const start = pendingReviews(w.office)[0]!;
    expect(await x.reviews.start(officeId(), run, start)).toBe(false);
    expect(x.sessions).toEqual([]);
    expect(stepsOf(s.run, "review")).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ endKind: DONE_END });
    expect(pendingReviews(w.office)).toEqual([]);
    const notices = noticesOf(REVIEW_NOTICES.doneOnBase);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain('"level":"info"');
    expect(JSON.stringify(notices[0])).toContain(`DIPO-1 is Done on the office base`);
    expect(JSON.stringify(notices[0])).toContain(s.run);
    // A second start for the same run does nothing.
    expect(await x.reviews.start(officeId(), findRun(w.office, s.run)!, start)).toBe(false);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(noticesOf(REVIEW_NOTICES.doneOnBase)).toHaveLength(1);
    expect(x.sessions).toEqual([]);
    expect(claimLive(s.run)).toBe(true);
  });

  it("ends a run waiting for the reviewer place as done, its wait cleared and its place free", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    // The first start reopened the run, and it waits for the reviewer place again.
    w.t.clock.advance(MINUTE);
    x.next = () => ({ kind: "failed", reason: "the host did not start" });
    expect(await x.places.drain(officeId())).toBe(0);
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: START_KINDS.review });
    x.next = null;
    setting.facts = onBase("Done");
    w.t.clock.advance(MINUTE);
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({
      endKind: DONE_END,
      waiting: null,
      waitingSince: null,
    });
    expect(findRun(w.office, s.run)?.endedAt).not.toBeNull();
    expect(placeHolders(w.office).reviewer).toEqual([]);
    expect(waitingStarts(w.office)).toEqual([]);
    expect(noticesOf(REVIEW_NOTICES.doneOnBase)).toHaveLength(1);
    expect(claimLive(s.run)).toBe(true);
    // The place is free for the next story's review.
    const next = inReview("DIPO-2", "tree-2");
    heads.set(next.run, "tree-2");
    setting.facts = FACTS;
    await reviewStarts(next);
  });

  it("keeps today's review for a story In Review on the base", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    setting.facts = onBase("In Review");
    await reviewStarts(s);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null });
    expect(noticesOf(REVIEW_NOTICES.doneOnBase)).toEqual([]);
    expect(claimLive(s.run)).toBe(true);
  });
});

/** The office config with the review caps `maxTurns` and `maxMinutes`. */
const withReviewCaps = (maxTurns: number, maxMinutes: number): OfficeConfig => ({
  ...OFFICE_DEFAULTS,
  review: { ...OFFICE_DEFAULTS.review, maxTurns, maxMinutes },
});

describe("the reviewer's caps from the run's snapshot (DIPO-247)", () => {
  it("keeps the snapshot's caps after the office config's review caps change", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    setting.config = withReviewCaps(10, 5);
    await reviewStarts(s);
    const run = findRun(w.office, s.run)!;
    expect(run).toMatchObject({ reviewMaxTurns: 60, reviewMaxMinutes: 30 });
    expect(reviewerSettings(w.office, run, setting.config)).toMatchObject({
      maxTurns: 60,
      maxMinutes: 30,
    });
  });

  it("writes the office's current caps into a snapshot that has none at the first review start, and keeps them", async () => {
    const s = inReview("DIPO-1", "tree-1", { reviewCaps: false });
    heads.set(s.run, "tree-1");
    expect(findRun(w.office, s.run)).toMatchObject({
      reviewMaxTurns: null,
      reviewMaxMinutes: null,
    });
    setting.config = withReviewCaps(45, 20);
    const session = await reviewStarts(s);
    expect(findRun(w.office, s.run)).toMatchObject({ reviewMaxTurns: 45, reviewMaxMinutes: 20 });
    // A later change of the office's caps reaches new runs only.
    setting.config = withReviewCaps(10, 5);
    expect(reviewerSettings(w.office, findRun(w.office, s.run)!, setting.config)).toMatchObject({
      maxTurns: 45,
      maxMinutes: 20,
    });
    // The next round of the run keeps them too.
    await turn(session, UNMET);
    await exits(session);
    fixedTo(s, "tree-2");
    await reviewStarts(s);
    expect(findRun(w.office, s.run)).toMatchObject({ reviewMaxTurns: 45, reviewMaxMinutes: 20 });
  });

  it("writes caps for a launcher asked directly for a run without them", () => {
    const s = inReview("DIPO-1", "tree-1", { reviewCaps: false });
    const settings = reviewerSettings(w.office, findRun(w.office, s.run)!, withReviewCaps(33, 11));
    expect(settings).toMatchObject({ maxTurns: 33, maxMinutes: 11 });
    expect(findRun(w.office, s.run)).toMatchObject({ reviewMaxTurns: 33, reviewMaxMinutes: 11 });
  });
});

describe("a refused reviewer launch plan (DIPO-247)", () => {
  it("raises one run.planRefused notice with planRefusedText, and the review waits", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const error = new PlanError("refused", { path: "/work/a(b)", character: "(" });
    w.t.clock.advance(MINUTE);
    x.next = () => ({
      kind: "failed",
      reason: `the launch plan refused it: ${error.message}`,
      planRefused: error,
    });
    expect(await x.places.drain(officeId())).toBe(0);
    w.t.clock.advance(MINUTE);
    expect(await x.places.drain(officeId())).toBe(0);
    const notices = noticesOf(LAUNCH_NOTICES.planRefused);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain(
      JSON.stringify(planRefusedText("DIPO-1", error)).slice(1, -1),
    );
    expect(JSON.stringify(notices[0])).toContain('"level":"error"');
    expect(parksOf()).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: START_KINDS.review });
  });
});

describe("a reviewer that ends without a verdict (0019 section 4)", () => {
  it("parks worker-failed when its host is lost twice in the round, with no review-failed step", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const first = await reviewStarts(s);
    x.control.onHostLost(first.run, first.agent);
    await x.control.idle();
    expect(x.sessions).toHaveLength(2);
    expect(parksOf()).toEqual([]);
    const second = x.sessions[1]!;
    x.control.onHostLost(second.run, second.agent);
    await x.control.idle();
    expect(x.sessions).toHaveLength(2);
    expect(parksOf()).toEqual([
      {
        story_id: "DIPO-1",
        reason: "worker-failed",
        detail:
          "the reviewer failed twice in review round 1: the reviewer host died while the daemon was down",
      },
    ]);
    expect(stepsOf(s.run, "review-failed")).toEqual([]);
    expect(stepsOf(s.run, "review")).toHaveLength(1);
    expect(events("story.state").at(-1)).toMatchObject({
      data: { story: "DIPO-1", from: "In Review", to: "Parked" },
    });
  });

  it("parks worker-failed past the reviewer's minute cap, with no review-failed step", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    // The developer's minute cap of 60 is not the reviewer's; 30 is. Run control's tick sees it.
    w.t.clock.advance(29 * MINUTE);
    await x.control.idle();
    expect(parksOf()).toEqual([]);
    w.t.clock.advance(MINUTE);
    await x.control.idle();
    const parks = parksOf();
    expect(parks).toEqual([
      expect.objectContaining({ story_id: "DIPO-1", reason: "worker-failed" }),
    ]);
    expect(parks[0]?.detail).toBe(
      "the reviewer's time cap reached: 30 of 30 minutes since the worker started",
    );
    await exits(session);
    expect(x.sessions).toHaveLength(1);
    expect(stepsOf(s.run, "review-failed")).toEqual([]);
    expect(events("story.state").at(-1)).toMatchObject({
      data: { story: "DIPO-1", from: "In Review", to: "Parked" },
    });
  });
});

describe("a run that ends reviewed hands its head to the fix rounds (DIPO-148)", () => {
  it("after the reviewer's exit, and when a new head takes its tree's blocked verdict without a round", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    const session = await reviewStarts(s);
    await turn(session, UNMET);
    expect(x.reviewedRuns).toEqual([]);
    await exits(session);
    expect(x.reviewedRuns).toEqual([`${s.run} ${session.agent}`]);

    // A head that changed only the task file: In Review again on the blocked tree.
    write(() => {
      w.office.run(
        `update runs set end_kind = $kind where office_id = $office_id and run_id = $run`,
        { run: s.run, kind: IN_REVIEW_END },
      );
    });
    expect(await x.places.drain(officeId())).toBe(0);
    expect(x.sessions).toHaveLength(1);
    expect(findRun(w.office, s.run)).toMatchObject({ endKind: REVIEWED_END });
    expect(x.reviewedRuns).toEqual([`${s.run} ${session.agent}`, `${s.run} -`]);
  });
});

describe("the review task message of a running run (DIPO-150, the DIPO-303 review)", () => {
  it("is built with the prompt budgets the run started with, not the ones in force", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    w.office.immediate(() => recordConfigSnapshot(w.office, "h", OFFICE_DEFAULTS, 0));
    // A base change reloaded a contract limit no story contract fits in: the run keeps its own.
    setting.config = {
      ...OFFICE_DEFAULTS,
      prompt: { ...OFFICE_DEFAULTS.prompt, contractMax: 10 },
    };
    const session = await reviewStarts(s);
    expect(session.message).toContain("src/greet.ts");
  });

  it("refuses a contract over the limit the run started with", async () => {
    const s = inReview("DIPO-1", "tree-1");
    heads.set(s.run, "tree-1");
    w.office.immediate(() =>
      recordConfigSnapshot(
        w.office,
        "h",
        { ...OFFICE_DEFAULTS, prompt: { ...OFFICE_DEFAULTS.prompt, contractMax: 10 } },
        0,
      ),
    );
    await x.places.drain(officeId());
    expect(x.sessions.filter((started) => started.run === s.run)).toEqual([]);
  });
});
