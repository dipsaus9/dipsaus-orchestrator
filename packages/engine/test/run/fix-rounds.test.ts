// Fix rounds (DIPO-148; 0019 sections 7, 8 and 13, 0021 sections 6 and 10): the review and CI
// feedback on a pushed head goes back to the same worker in one round, once per head. The places,
// run control, the fix rounds and the feedback facts are real on a migrated state database; the
// story read, the CI state of the PR poll, the status commit and the developer's next session are
// fakes, and a "session" is a developer agent row the fake start writes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { OfficeId, RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import { conflictFeedbackItem } from "../../src/box/collisions";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { type AutoMergeGuard, guardedUnparkWriter } from "../../src/merge/guard";
import { ciFeedback, type CiFeedbackItem } from "../../src/prompts/feedback";
import { recordReviewOverride, recordReviewVerdict } from "../../src/review";
import type { JudgedReview } from "../../src/review/verdict";
import {
  endRun,
  FIX_NOTICES,
  FIX_LIFT_TRIES,
  FixRounds,
  feedbackItems,
  findRun,
  IN_REVIEW_END,
  Places,
  REVIEWED_END,
  REVIEWER_ROLE,
  RunControl,
  type RunView,
  runIntents,
  START_KINDS,
} from "../../src/run";
import type { UnparkBranchRequest } from "../../src/run/park";
import type { RunStoryFacts } from "../../src/run/resume";
import { activeSignals } from "../../src/run/signals";
import { heldFirstMessage } from "./held-session";
import type { CiHeadState } from "../../src/story-pr/prs";
import { encode } from "../../src/workers/claude-cli/encode";
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
  workOf,
} from "./rounds-helpers";

let w: RoundsWorld;

beforeEach(async () => {
  w = await roundsWorld("fix-rounds-");
});

afterEach(() => w.close());

const now = (): number => w.t.clock.now();
const write = <T>(fn: () => T): T => w.office.immediate(fn);
const officeId = (): OfficeId => w.office.officeId as OfficeId;

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const QUOTE = "export const total = (a: number, b: number) => a - b;";

const FACTS: RunStoryFacts = {
  view: plainTask(),
  fields: {},
  taskFile: "backlog/tasks/shop-12 - Add-a-greeting.md",
  dependencies: [],
};

/** A blocked verdict: an unmet criterion, a blocking finding and an advisory one. */
const BLOCKED: JudgedReview = {
  verdict: "blocked",
  criteria: [
    { n: 1, status: "met", evidence: "src/greet.ts:1 prints the greeting." },
    { n: 2, status: "unmet", evidence: "nothing checks an empty name." },
  ],
  findings: [
    {
      severity: "blocking",
      kind: "correctness",
      file: "src/greet.ts",
      line: 2,
      quote: QUOTE,
      text: "total subtracts instead of adding.",
    },
    { severity: "advisory", kind: "maintainability", text: "name the helper better." },
  ],
  summary: "Criterion 2 and total.",
  notes: [],
};

const APPROVED: JudgedReview = {
  verdict: "approved",
  criteria: [
    { n: 1, status: "met", evidence: "fine" },
    { n: 2, status: "met", evidence: "fine" },
  ],
  findings: [{ severity: "advisory", kind: "maintainability", text: "name the helper better." }],
  summary: "Fine.",
  notes: [],
};

const LOG =
  "Typecheck\tRun tsc\t2026-10-22T10:00:00.0000000Z src/greet.ts(2,5): error TS2322: no.\n";

/** A red CI item of check `check` with the same failure each time. */
const red = (check = "ci-ok"): CiFeedbackItem =>
  ciFeedback({ check, link: "https://github.com/o/r/actions/runs/1/job/2", log: LOG });

interface Started {
  readonly run: RunId;
  readonly mode: "resume" | "handoff";
  readonly why: string;
  readonly message: string | undefined;
  readonly work: WorkRef;
}

interface World {
  readonly fix: FixRounds;
  readonly places: Places;
  readonly control: RunControl;
  readonly started: Started[];
  readonly lifts: UnparkBranchRequest[];
  readonly ci: Map<string, CiHeadState>;
  readonly box: Set<string>;
  readonly warned: unknown[];
  config: OfficeConfig;
  facts: RunStoryFacts;
  /** The next session start answers this; true by default. */
  starts: boolean;
  /** The fakes' other knobs. */
  readonly s: Knobs;
  close(): void;
}

interface Knobs {
  /** The code tree key of each head (`treeKey`); a head not listed has its own. */
  readonly trees: Map<string, string>;
  /** Worker outcomes have no view of the run (no caps). */
  viewNull: boolean;
  /** How many of the next status commits fail. */
  liftFails: number;
  /** The daemon stops right after the session's agent is recorded: the start never returns. */
  stopAfterRecord: boolean;
  /** The auto-merge guard the daemon puts around the lift (0002); none by default. */
  guard: AutoMergeGuard | null;
}

let x: World;

/** Worker outcomes' view of a run: it names the run's newest agent, here the reviewer. */
const view = (_office: OfficeId, _handle: unknown, run: { runId: RunId }): RunView => ({
  office: officeId(),
  runId: run.runId,
  work: { ...workOf(storyOf(run.runId), "agt-reviewer" as never, REVIEWER_ROLE) },
  caps: { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 60 },
  startedAt: 0,
  snapshot: null,
});

function world(): World {
  const started: Started[] = [];
  const lifts: UnparkBranchRequest[] = [];
  const ci = x?.ci ?? new Map<string, CiHeadState>();
  const box = x?.box ?? new Set<string>();
  const s: Knobs = {
    trees: x?.s.trees ?? new Map(),
    viewNull: false,
    liftFails: 0,
    stopAfterRecord: false,
    guard: null,
  };
  const warned: unknown[] = [];
  const state = { config: OFFICE_DEFAULTS as OfficeConfig, facts: FACTS, starts: true };
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
    steering: { send: async () => ({ ok: true }) },
    encode,
  });
  let places: Places | null = null;
  const fix = new FixRounds({
    clock: w.t.clock,
    offices: { get: () => w.office, config: () => state.config },
    story: async () => state.facts,
    ci: (_office, runId) => ci.get(runId) ?? null,
    sessions: {
      next: async (_office, run, runView, request) => {
        started.push({
          run: run.runId,
          mode: request.mode,
          why: request.why,
          // The held messages, delivered with the agent's record as `RunResumer` does.
          message: heldFirstMessage(w.office, run.runId, now(), state.starts),
          work: runView.work,
        });
        if (!state.starts) return false;
        addAgent(w, run.runId, "developer", true);
        if (s.stopAfterRecord) throw new Error("the daemon stopped");
        return true;
      },
    },
    view: (office, handle, run) => (s.viewNull ? null : view(office, handle, run)),
    // As the daemon composes it: the lift through the auto-merge guard (0002).
    unpark: guardedUnparkWriter(
      {
        lift: async (_office, request) => {
          if (s.liftFails > 0) {
            s.liftFails -= 1;
            throw new Error("the push was refused");
          }
          lifts.push(request);
          return { commit: "f".repeat(40), pushed: true, pushError: null };
        },
      },
      (office, branch, run) => (s.guard === null ? run() : s.guard(office, branch, run)),
    ),
    boxRun: (_office, run) => box.has(run.runId),
    places: () => places ?? undefined,
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    treeKey: async (_office, _run, _taskFile, head) =>
      s.trees.get(head) ?? `tree-${head.slice(0, 4)}`,
    warn: (message, fields) => warned.push({ message, fields }),
  });
  places = new Places({
    clock: w.t.clock,
    offices: { get: () => w.office },
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    starters: { fix: (office, run, start) => fix.start(office, run, start) },
  });
  const built = places;
  return {
    fix,
    places: built,
    control,
    started,
    lifts,
    ci,
    box,
    warned,
    s,
    get config() {
      return state.config;
    },
    set config(value) {
      state.config = value;
    },
    get facts() {
      return state.facts;
    },
    set facts(value) {
      state.facts = value;
    },
    get starts() {
      return state.starts;
    },
    set starts(value) {
      state.starts = value;
    },
    close: () => {
      built.close();
      control.close();
    },
  };
}

const stories = new Map<string, StoryRun>();
const storyOf = (run: RunId): StoryRun => stories.get(run) as StoryRun;

beforeEach(() => {
  stories.clear();
  x = undefined as unknown as World;
  x = world();
});

afterEach(() => x.close());

/** A story run that worked, was reviewed or not yet, and ended at In Review now. */
function inReview(story: string, options: { budgetLimit?: number } = {}): StoryRun {
  const s = storyRun(w, {
    story,
    reviewRoundCap: 3,
    reviewMaxTurns: 60,
    reviewMaxMinutes: 30,
    reviewMaxTokens: 200_000,
    budgetLimit: options.budgetLimit ?? 1_000_000,
  });
  stories.set(s.run, s);
  addAgent(w, s.run, "developer", false);
  write(() => endRun(w.office, s.run, now(), IN_REVIEW_END));
  return s;
}

/** The review of `head` decided `judged`: its verdict stored and the review period ended. */
function reviewed(s: StoryRun, head: string, judged: JudgedReview): void {
  addAgent(w, s.run, REVIEWER_ROLE, false, "opus");
  write(() => {
    recordReviewVerdict(w.office, w.t.ids, {
      runId: s.run,
      key: s.key,
      round: 1,
      agent: null,
      model: "opus",
      commit: head,
      codeTreeKey: `tree-${head.slice(0, 4)}`,
      judged,
      at: now(),
    });
    w.office.run(
      `update runs set end_kind = $kind where office_id = $office_id and run_id = $run`,
      { run: s.run, kind: REVIEWED_END },
    );
  });
  w.t.clock.advance(1_000);
}

/** The worker's fix came back In Review at a new head: the run ended again. */
function backInReview(s: StoryRun): void {
  write(() =>
    w.office.run(
      `update agents set ended_at = $at, end_reason = 'exited'
        where office_id = $office_id and run_id = $run and ended_at is null`,
      { run: s.run, at: now() },
    ),
  );
  write(() => endRun(w.office, s.run, now(), IN_REVIEW_END));
  w.t.clock.advance(1_000);
}

const events = (type: string) => loggedEvents(w.office).filter((event) => event.type === type);

const parksOf = () =>
  w.office.all<{ reason: string }>(
    "select reason from parks where office_id = $office_id order by park_id",
  );

/** The run's fix round messages: held `steer` intents of the one feedback path. */
const fixIntentsOf = (run: RunId) =>
  runIntents(w.office, run).filter((intent) =>
    /^feedback (review|ci|reject|conflict) \S+ next /.test(intent.detail),
  );

describe("the timing of a fix round (0019 section 7)", () => {
  it("waits for both the head's verdict and its final checks, then sends one message", async () => {
    const s = inReview("DIPO-1");
    x.ci.set(s.run, { kind: "pending", head: H1 });
    // No verdict yet: the review of the head is still pending.
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    reviewed(s, H1, BLOCKED);
    // The verdict is in, the checks are not final.
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(feedbackItems(w.office, s.run)).toEqual([]);
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    // One round with the review's two items and the CI item, all for the head.
    expect(feedbackItems(w.office, s.run).map((item) => [item.source, item.head])).toEqual([
      ["review", H1],
      ["review", H1],
      ["ci", H1],
    ]);
    expect(JSON.stringify(events("engine.notice"))).toContain(FIX_NOTICES.queued);
    // The worker place was free: the round started at once, with the status commit first.
    expect(x.lifts).toEqual([
      expect.objectContaining({ story: "DIPO-1", to: "In Progress", branch: "DIPO-1/a-story" }),
    ]);
    expect(x.started).toHaveLength(1);
    const [session] = x.started;
    expect(session?.mode).toBe("resume");
    expect(session?.message).toContain(`Your pushed commit ${H1.slice(0, 12)} got feedback`);
    expect(session?.message).toContain("Item 1 (review):");
    expect(session?.message).toContain("acceptance criterion #2 unmet");
    expect(session?.message).toContain("Item 2 (review):");
    expect(session?.message).toContain(`Quoted line: ${QUOTE}`);
    expect(session?.message).toContain("Item 3 (ci):\nRequired check ci-ok failed");
    // Advisory findings are listed as optional.
    expect(session?.message).toContain("Optional: the reviewer also left these advisory findings.");
    expect(session?.message).toContain("- maintainability: name the helper better.");
    // The developer's session continues, not the reviewer's.
    expect(String(session?.work.role)).toBe("developer");
    expect(String(session?.work.agent)).not.toBe("agt-reviewer");
    // Delivered: the held message resolved, keyed on the head, every row with its send time.
    expect(fixIntentsOf(s.run)).toEqual([
      expect.objectContaining({ kind: "steer", state: "resolved", outcome: "resumed" }),
    ]);
    expect(fixIntentsOf(s.run)[0]?.detail.startsWith(`feedback review ${H1} next `)).toBe(true);
    expect(feedbackItems(w.office, s.run).every((item) => item.sentAt !== null)).toBe(true);
    expect(events("story.state").at(-1)).toMatchObject({
      data: { story: "DIPO-1", from: "In Review", to: "In Progress" },
    });
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: null });
    // A later poll of the same head sends nothing more.
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(x.started).toHaveLength(1);
  });

  it("sends nothing for a blocked verdict the maintainer overrode (DIPO-150)", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    write(() => {
      const gate = w.office.get<{ gate_id: string }>(
        "select gate_id from review_verdicts where office_id = $office_id and run_id = $run",
        { run: s.run },
      )?.gate_id;
      recordReviewOverride(w.office, gate as never, { note: "fine as it is", at: now() });
    });
    x.ci.set(s.run, { kind: "green", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(feedbackItems(w.office, s.run)).toEqual([]);
  });

  it("starts no round for advisory findings alone, and lists them when CI is red", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, APPROVED);
    x.ci.set(s.run, { kind: "green", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(feedbackItems(w.office, s.run)).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ endKind: REVIEWED_END });
    // Red CI on the approved head is a reason: the advisory goes along as optional.
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started[0]?.message).toContain("Item 1 (ci):");
    expect(x.started[0]?.message).toContain("Optional:");
  });

  it("does not wait for CI that never runs: a box run's head with no CI, or an office without story PRs", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "none", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    const t = inReview("DIPO-2");
    reviewed(t, H2, BLOCKED);
    x.config = { ...OFFICE_DEFAULTS, storyPr: { ...OFFICE_DEFAULTS.storyPr, open: false } };
    expect(await x.fix.consider(officeId(), t.run)).toBe(true);
    expect(feedbackItems(w.office, t.run).map((item) => item.head)).toEqual([H2, H2]);
  });

  it("sends the review items once the checks are past the wait cap", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "stuck", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    expect(feedbackItems(w.office, s.run).map((item) => item.source)).toEqual(["review", "review"]);
  });

  it("starts no round while a reviewer session of the run still runs, unless it is the one that exited", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    const reviewer = addAgent(w, s.run, REVIEWER_ROLE, true, "opus");
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(await x.fix.consider(officeId(), s.run, { exited: reviewer })).toBe(true);
  });

  it("starts no round for a story Done on the base", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    x.facts = { ...FACTS, view: plainTask({ status: "Done" }) };
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(feedbackItems(w.office, s.run)).toEqual([]);
  });
});

describe("send-once (0019 section 8)", () => {
  it("sends an item for one head once across a daemon restart, and marks the same signature on a new head a repeat", async () => {
    // The worker place is held, so the queued round waits across the restart.
    const busy = storyRun(w, { story: "DIPO-9" });
    addAgent(w, busy.run, "developer", true);
    const s = inReview("DIPO-1");
    reviewed(s, H1, APPROVED);
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started).toEqual([]);
    expect(findRun(w.office, s.run)).toMatchObject({ waiting: START_KINDS.fix });

    // A restart: new services over the same state; the poll tells the same red head again.
    x.close();
    x = world();
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(fixIntentsOf(s.run)).toHaveLength(1);
    expect(feedbackItems(w.office, s.run)).toHaveLength(1);

    // The place frees: the one stored round starts with its one message.
    write(() =>
      w.office.run(
        "update agents set ended_at = $at where office_id = $office_id and run_id = $run",
        { at: now(), run: busy.run },
      ),
    );
    write(() => endRun(w.office, busy.run, now(), IN_REVIEW_END));
    await x.places.drain(officeId());
    expect(x.started).toHaveLength(1);
    expect(x.started[0]?.message).toContain("Item 1 (ci):");
    expect(x.started[0]?.message).not.toContain("still failing");
    expect(activeSignals(w.office, s.run).map((signal) => signal.signal)).not.toContain(
      "same-failure",
    );

    // The fix came back at a new head, approved, with the same CI failure: a repeat, and the same
    // CI signature sent twice in a row raises the watchdog signal.
    backInReview(s);
    reviewed(s, H2, APPROVED);
    x.ci.set(s.run, { kind: "red", head: H2, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(feedbackItems(w.office, s.run).map((item) => [item.head, item.repeat])).toEqual([
      [H1, false],
      [H2, true],
    ]);
    expect(x.started[1]?.message).toContain("Item 1 (ci, still failing after your last change):");
    expect(activeSignals(w.office, s.run).map((signal) => signal.signal)).toContain("same-failure");
    expect(events("work.observed").at(-1)).toMatchObject({ data: { signal: "same-failure" } });
  });

  it("gives a box run's developer a new session in its box with the feedback as its task", async () => {
    const s = inReview("DIPO-1");
    x.box.add(s.run);
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "none", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started.map((started) => started.mode)).toEqual(["handoff"]);
    expect(x.started[0]?.message).toContain("Item 1 (review):");
  });

  it("keeps the feedback undelivered with its intent when the session does not start", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "green", head: H1 });
    x.starts = false;
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started).toHaveLength(1);
    expect(fixIntentsOf(s.run)).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(feedbackItems(w.office, s.run).every((item) => item.sentAt === null)).toBe(true);
  });
});

describe("the pre-start cap check (DIPO-205)", () => {
  it("stores the round's feedback_items rows first, then parks budget-exceeded, and the rows stay with no delivered intent", async () => {
    const s = inReview("DIPO-1", { budgetLimit: 1_000 });
    const developer = w.office.get<{ agent_id: string }>(
      "select agent_id from agents where office_id = $office_id and run_id = $run",
      { run: s.run },
    )?.agent_id as never;
    // The done path crossed the budget cap.
    addUsage(w, s.run, developer, "developer", { turns: 3, tokens: 5_000 });
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started).toEqual([]);
    expect(x.lifts).toEqual([]);
    expect(parksOf()).toEqual([{ reason: "budget-exceeded" }]);
    const rows = feedbackItems(w.office, s.run);
    expect(rows.map((row) => row.source)).toEqual(["review", "review", "ci"]);
    expect(rows.every((row) => row.sentAt === null)).toBe(true);
    const [intent] = fixIntentsOf(s.run);
    expect(intent).toMatchObject({ kind: "steer", state: "pending", sentAt: null });
    expect(rows.every((row) => row.intentId === intent?.intentId)).toBe(true);
    // A parked story gets no further round.
    w.t.clock.advance(MINUTE);
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
  });
});

describe("a maintainer reject (0019 sections 8 and 11)", () => {
  it("goes to the worker at once through the same send path, the note verbatim and keyed on the gate id", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, APPROVED);
    // Before DIPO-151 nothing produces a reject: an approved, green head sends nothing.
    x.ci.set(s.run, { kind: "green", head: H1 });
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    const note = "Keep the old flag: `shop greet --name` must still work.";
    expect(await x.fix.reject(officeId(), s.run, { gateId: "gat-7", note })).toBe(true);
    await x.fix.idle();
    expect(feedbackItems(w.office, s.run)).toEqual([
      expect.objectContaining({
        source: "reject",
        signature: "gate:gat-7",
        head: H1,
        text: `The maintainer rejected this change with this note:\n${note}`,
      }),
    ]);
    expect(x.started[0]?.message).toContain(note);
    expect(x.started[0]?.message).toContain("Item 1 (reject):");
  });
});

describe("a conflict hand-off of a story In Review (DIPO-149, the merge slot's entry)", () => {
  it("goes to the worker at once, once per head and signature, through the same send path", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, APPROVED);
    x.ci.set(s.run, { kind: "green", head: H1 });
    const item = conflictFeedbackItem({
      base: "main",
      onto: "d".repeat(40),
      conflicts: [{ path: "src/greet.ts", kind: "content" }],
      hunks: ["--- src/greet.ts (lines 1-5)\n<<<<<<< ours\na\n=======\nb\n>>>>>>> main"],
    });
    expect(await x.fix.conflict(officeId(), s.run, { head: H1, item })).toBe(true);
    await x.fix.idle();
    expect(feedbackItems(w.office, s.run)).toEqual([
      expect.objectContaining({ source: "conflict", signature: item.signature, head: H1 }),
    ]);
    expect(x.started[0]?.message).toContain("Item 1 (conflict):");
    expect(x.started[0]?.message).toContain("Conflicted files: content: src/greet.ts");
  });
});

describe("a verdict and checks of different heads", () => {
  it("waits for the CI of the verdict's head, unless the CI's head has the verdict's code tree", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    // The poll still tells of another head, with another tree: no round.
    x.ci.set(s.run, { kind: "red", head: H2, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(false);
    expect(feedbackItems(w.office, s.run)).toEqual([]);
    // Once the CI of the verdict's head is final, the round goes.
    x.ci.set(s.run, { kind: "red", head: H1, items: [red()] });
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    expect(feedbackItems(w.office, s.run).map((item) => item.head)).toEqual([H1, H1, H1]);

    // A head that changed only the task file has the verdict's tree: the verdict holds for it.
    const t = inReview("DIPO-2");
    reviewed(t, H1, BLOCKED);
    x.s.trees.set(H2, `tree-${H1.slice(0, 4)}`);
    x.ci.set(t.run, { kind: "green", head: H2 });
    expect(await x.fix.consider(officeId(), t.run)).toBe(true);
    expect(feedbackItems(w.office, t.run).map((item) => item.head)).toEqual([H2, H2]);
  });
});

/** A run reviewed blocked on H1 with green CI: its fix round is ready to queue. */
const waitingFix = (story: string): StoryRun => {
  const s = inReview(story);
  reviewed(s, H1, BLOCKED);
  x.ci.set(s.run, { kind: "green", head: H1 });
  return s;
};

describe("a fix round that cannot start", () => {
  it("parks worker-failed when it has no feedback, instead of holding the place", async () => {
    const s = inReview("DIPO-1");
    // A wait for a fix round with no intent behind it.
    write(() =>
      w.office.run(
        `update runs set ended_at = null, end_kind = null, waiting = $kind, waiting_since = $at
          where office_id = $office_id and run_id = $run`,
        { run: s.run, kind: START_KINDS.fix, at: now() },
      ),
    );
    await x.places.drain(officeId());
    expect(parksOf()).toEqual([{ reason: "worker-failed" }]);
    expect(findRun(w.office, s.run)?.endedAt).not.toBeNull();
    expect(x.started).toEqual([]);
    expect(runIntents(w.office, s.run).filter((i) => i.kind === "park")).toEqual([
      expect.objectContaining({ state: "resolved" }),
    ]);
  });

  it("parks when worker outcomes have no view of the run, keeping the feedback undelivered", async () => {
    const s = waitingFix("DIPO-1");
    x.s.viewNull = true;
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(parksOf()).toEqual([{ reason: "worker-failed" }]);
    expect(x.started).toEqual([]);
    expect(feedbackItems(w.office, s.run).every((item) => item.sentAt === null)).toBe(true);
  });

  it("waits again after a failed status commit, and parks after FIX_LIFT_TRIES in a row", async () => {
    const s = waitingFix("DIPO-1");
    x.s.liftFails = FIX_LIFT_TRIES;
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    for (let attempt = 1; attempt < FIX_LIFT_TRIES; attempt += 1) {
      expect(parksOf()).toEqual([]);
      expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: START_KINDS.fix });
      await x.places.drain(officeId());
    }
    expect(parksOf()).toEqual([{ reason: "worker-failed" }]);
    expect(x.started).toEqual([]);
  });

  it("waits again after a single failed status commit and then starts", async () => {
    const s = waitingFix("DIPO-1");
    x.s.liftFails = 1;
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started).toEqual([]);
    await x.places.drain(officeId());
    expect(x.started).toHaveLength(1);
    expect(parksOf()).toEqual([]);
  });
});

describe("delivery with the session's start", () => {
  it("marks the round delivered in the transaction that records the new agent, so a stop right after never sends it twice", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    x.ci.set(s.run, { kind: "green", head: H1 });
    x.s.stopAfterRecord = true;
    expect(await x.fix.consider(officeId(), s.run)).toBe(true);
    await x.fix.idle();
    expect(x.started).toHaveLength(1);
    expect(fixIntentsOf(s.run)).toEqual([
      expect.objectContaining({ state: "resolved", outcome: "resumed" }),
    ]);
    expect(feedbackItems(w.office, s.run).every((item) => item.sentAt !== null)).toBe(true);
    // A restart: nothing of the round is sent again.
    x.close();
    x = world();
    expect(await x.fix.recover(officeId())).toBe(0);
    await x.places.drain(officeId());
    expect(x.started).toEqual([]);
  });
});

describe("the recovery step", () => {
  it("decides the round of a reviewed head whose CI will not tell again", async () => {
    x.config = { ...OFFICE_DEFAULTS, storyPr: { ...OFFICE_DEFAULTS.storyPr, open: false } };
    const s = inReview("DIPO-1");
    reviewed(s, H1, BLOCKED);
    const ok = inReview("DIPO-2");
    reviewed(ok, H2, APPROVED);
    // The daemon stopped before the reviewer's exit reached the fix rounds.
    x.close();
    x = world();
    x.config = { ...OFFICE_DEFAULTS, storyPr: { ...OFFICE_DEFAULTS.storyPr, open: false } };
    expect(await x.fix.recover(officeId())).toBe(1);
    expect(feedbackItems(w.office, s.run).map((item) => item.head)).toEqual([H1, H1]);
    expect(feedbackItems(w.office, ok.run)).toEqual([]);
    // A second recovery queues nothing new.
    expect(await x.fix.recover(officeId())).toBe(0);
  });
});

describe("the fix round's lift through the auto-merge guard (0002)", () => {
  it("turns auto-merge off before the In Progress commit, and starts nothing when it cannot", async () => {
    const s = inReview("DIPO-1");
    reviewed(s, H1, APPROVED);
    x.ci.set(s.run, { kind: "green", head: H1 });
    const order: string[] = [];
    let refuse = true;
    x.s.guard = async (_office, branch, lift) => {
      order.push(`off ${branch}`);
      if (refuse) throw new Error("turning auto-merge off for PR #7 failed (GitHub refused)");
      return lift();
    };
    expect(await x.fix.reject(officeId(), s.run, { gateId: "gat-7", note: "Fix it." })).toBe(true);
    await x.fix.idle();
    // Auto-merge could not go off: no commit reached the branch and no session started.
    expect(x.lifts).toEqual([]);
    expect(x.started).toEqual([]);
    refuse = false;
    await x.places.drain(officeId());
    await x.fix.idle();
    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(x.lifts.map((lift) => lift.to)).toEqual(["In Progress"]);
    expect(x.started).toHaveLength(1);
  });
});
