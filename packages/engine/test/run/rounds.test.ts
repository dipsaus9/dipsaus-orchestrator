// The run across review rounds (DIPO-142, 0019 section 13), fast and local: one story run ends its
// active period at In Review and reopens on the same run for a review, a fix round and a conflict
// hand-off. The developer's minute cap leaves out the idle and review time, the reviewer's turns
// stay out of the developer's turn cap while its tokens count toward the story budget, each end
// rewrites the provisional outcome row and Done writes the final one.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Caps } from "../../src/workers/types";
import {
  appendRunStep,
  capsStartedAt,
  claimPlace,
  DONE_END,
  endReviewPeriod,
  endRun,
  findRun,
  firedCap,
  IN_REVIEW_END,
  reopenForRound,
  reopenRun,
  REVIEWED_END,
  runOutcome,
  runTotals,
} from "../../src/run";
import { endRunMarked } from "../../src/run/markers";
import { runProgress } from "../../src/views/work";
import { DONE_RELEASE_REASON } from "../../src/worktree/teardown";
import { releaseClaim } from "../../src/worktree/records";
import { countRows } from "../commands/helpers";
import {
  addAgent,
  addUsage,
  endAgent,
  MINUTE,
  type RoundsWorld,
  roundsWorld,
  storyRun,
  type StoryRun,
} from "./rounds-helpers";

let w: RoundsWorld;
let s: StoryRun;

beforeEach(async () => {
  w = await roundsWorld("rounds-");
  s = storyRun(w, { story: "DIPO-7", maxMinutes: 20 });
});

afterEach(() => w.close());

const now = (): number => w.t.clock.now();
const advance = (minutes: number): void => w.t.clock.advance(minutes * MINUTE);
const write = <T>(fn: () => T): T => w.office.immediate(fn);

/** 10 minutes of developer work with two verify loops, then the In Review end. */
function workToInReview(): number {
  const started = now();
  const developer = addAgent(w, s.run, "developer", true);
  advance(10);
  write(() => {
    appendRunStep(w.office, s.run, "loop", "1", now());
    appendRunStep(w.office, s.run, "loop", "2", now());
  });
  addUsage(w, s.run, developer, "developer", { turns: 12, tokens: 6_000 });
  endAgent(w, developer);
  write(() => endRunMarked(w.office, s.run, now(), IN_REVIEW_END));
  return started;
}

describe("a run reopened after In Review (0019 section 13)", () => {
  it("keeps its loop count and its minute cap leaves out the idle and review time", () => {
    const started = workToInReview();
    expect(runOutcome(w.office, s.run)).toMatchObject({
      endKind: IN_REVIEW_END,
      final: false,
      loops: 2,
      minutes: 10,
    });

    // 30 minutes idle, then a review round: it waits 5 minutes for the reviewer place and reviews
    // for 20.
    advance(30);
    const entries = write(() =>
      reopenForRound(w.office, findRun(w.office, s.run)!, "review", now()),
    );
    expect(entries.map((entry) => entry.type)).toContain("work.phase");
    expect(findRun(w.office, s.run)).toMatchObject({ endedAt: null, waiting: "review" });
    expect(countRows(w.office, "run_outcomes")).toBe(0);
    advance(5);
    write(() => claimPlace(w.office, s.run, now()));
    const reviewer = addAgent(w, s.run, "reviewer", true, "opus");
    advance(20);
    addUsage(w, s.run, reviewer, "reviewer", { turns: 40, tokens: 5_000 });
    endAgent(w, reviewer);
    write(() => {
      appendRunStep(w.office, s.run, "review", "1", now());
      appendRunStep(w.office, s.run, "review-failed", "1", now());
      expect(endReviewPeriod(w.office, s.run, now())).toBe(true);
    });
    // The review's end rewrote the provisional row; the developer worked 10 minutes so far.
    expect(findRun(w.office, s.run)?.parkedMs).toBe(55 * MINUTE);
    expect(runOutcome(w.office, s.run)).toMatchObject({
      endKind: REVIEWED_END,
      final: false,
      minutes: 10,
      reviewRounds: 1,
      reviewRoundsFailed: 1,
    });

    // 10 minutes idle, then the fix round waits 3 minutes for the worker place; 7 minutes of work.
    advance(10);
    write(() => reopenForRound(w.office, findRun(w.office, s.run)!, "fix", now()));
    expect(findRun(w.office, s.run)?.waiting).toBe("fix");
    advance(3);
    write(() => claimPlace(w.office, s.run, now()));
    addAgent(w, s.run, "developer", true);
    advance(7);
    const reopened = findRun(w.office, s.run)!;
    expect(reopened.parkedMs).toBe(68 * MINUTE);
    expect(reopened.waiting).toBeNull();
    // The same run keeps its loops: two, as before the review.
    expect(runProgress(w.office, s.run)?.loop).toBe(2);

    const caps: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 20 };
    const from = capsStartedAt(reopened, started);
    expect(now() - from).toBe(17 * MINUTE);
    expect(firedCap(caps, runTotals(w.office, s.run, from, now()))).toBeNull();
    // Counted from the run's start, the 20-minute cap would have fired long ago.
    expect(firedCap(caps, runTotals(w.office, s.run, started, now()))?.cap).toBe("maxMinutes");
  });

  it("never reopens a run whose story is Done", () => {
    workToInReview();
    write(() => endRun(w.office, s.run, now(), DONE_END));
    expect(write(() => reopenRun(w.office, s.run, now()))).toBe(false);
    expect(write(() => reopenForRound(w.office, findRun(w.office, s.run)!, "fix", now()))).toEqual(
      [],
    );
    expect(findRun(w.office, s.run)?.endKind).toBe(DONE_END);
  });

  it("ends a review period only for a run open in a review", () => {
    workToInReview();
    expect(write(() => endReviewPeriod(w.office, s.run, now()))).toBe(false);
    write(() => reopenForRound(w.office, findRun(w.office, s.run)!, "conflict", now()));
    expect(findRun(w.office, s.run)?.waiting).toBe("conflict");
    expect(write(() => endReviewPeriod(w.office, s.run, now()))).toBe(false);
  });
});

describe("the reviewer's turns and tokens (0019 sections 4 and 13)", () => {
  it("count toward the run's budget, never toward the developer's turn cap", () => {
    const developer = addAgent(w, s.run, "developer", false);
    const reviewer = addAgent(w, s.run, "reviewer", false, "opus");
    addUsage(w, s.run, developer, "developer", { turns: 20, tokens: 6_000 });
    addUsage(w, s.run, reviewer, "reviewer", { turns: 40, tokens: 5_000 });
    const totals = runTotals(w.office, s.run, now(), now());
    expect(totals).toEqual({ budgetTokens: 11_000, turns: 20, elapsedMs: 0 });
    // 60 turns in all, but the developer's cap of 30 has 10 left; the budget counts both agents.
    expect(firedCap({ budgetTokens: 20_000, maxTurns: 30, maxMinutes: 60 }, totals)).toBeNull();
    expect(firedCap({ budgetTokens: 10_000, maxTurns: 30, maxMinutes: 60 }, totals)?.cap).toBe(
      "budgetTokens",
    );
  });
});

describe("the outcome row (0019 section 13)", () => {
  it("is rewritten at each end and made final at Done with the round counts", () => {
    workToInReview();
    advance(5);
    write(() => reopenForRound(w.office, findRun(w.office, s.run)!, "fix", now()));
    write(() => claimPlace(w.office, s.run, now()));
    const developer = addAgent(w, s.run, "developer", true);
    advance(4);
    endAgent(w, developer);
    write(() => {
      appendRunStep(w.office, s.run, "review", "1", now());
      appendRunStep(w.office, s.run, "review-failed", "1", now());
      appendRunStep(w.office, s.run, "review", "2", now());
      appendRunStep(w.office, s.run, "ci", "a1b2c3d", now());
      // A hand-off counts once, at its start; its feedback turn is no second one (DIPO-149).
      appendRunStep(w.office, s.run, "conflict", "start 1 a1b2c3d", now());
      appendRunStep(w.office, s.run, "conflict", "feedback 1", now());
      appendRunStep(w.office, s.run, "override", "gat_1", now());
      endRunMarked(w.office, s.run, now(), IN_REVIEW_END);
    });
    expect(runOutcome(w.office, s.run)).toMatchObject({
      outcome: IN_REVIEW_END,
      final: false,
      minutes: 14,
    });

    // The Done poll's teardown releases the claim with `done`: the final row, in its transaction.
    expect(DONE_RELEASE_REASON).toBe(DONE_END);
    advance(60);
    write(() =>
      releaseClaim(w.office, s.run, { at: now(), reason: DONE_RELEASE_REASON, keepBranch: false }),
    );
    const final = runOutcome(w.office, s.run);
    expect(final).toMatchObject({
      outcome: DONE_END,
      endKind: DONE_END,
      final: true,
      loops: 2,
      reviewRounds: 2,
      reviewRoundsFailed: 1,
      ciAttempts: 1,
      conflictHandoffs: 1,
      override: true,
      // The time after the last active period is no work.
      minutes: 14,
    });
    expect(findRun(w.office, s.run)?.endKind).toBe(DONE_END);
    // A final row is never rewritten.
    write(() => endRun(w.office, s.run, now(), DONE_END));
    expect(runOutcome(w.office, s.run)).toEqual(final);
  });

  it("is final with outcome done even when the run parked on the way", () => {
    workToInReview();
    write(() =>
      w.office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           at, resolved_at, resolved_how)
         values ($office_id, 1, $key, 'DIPO-7', $run, 'worker-failed', 'In Progress',
           'Bash: x', 0, 1, 'resume')`,
        { key: s.key, run: s.run },
      ),
    );
    write(() => endRun(w.office, s.run, now(), DONE_END));
    expect(runOutcome(w.office, s.run)).toMatchObject({
      outcome: DONE_END,
      final: true,
      parkReasons: ["worker-failed"],
    });
  });
});
