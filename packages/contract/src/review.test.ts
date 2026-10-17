// The review loop's shapes (0019 section 15): each new optional field parses, and payloads
// without it still parse. The three office codes are not retryable.

import { describe, expect, it } from "bun:test";

import { contractCommands, engineError, findEvent, OFFICE_ERROR_CODES } from "./index";
import { gateDecided, Verdict } from "./office";
import { eventFixtures, ids, progress, storyView } from "./fixtures";
import { Progress, ReviewSummary, ReviewVerdict, StoryPr, StoryView } from "./work";

const reviewVerdict = {
  round: 2,
  commit: "4f2a9c1d",
  treeKey: "tree_9b1e",
  verdict: "blocked" as const,
  criteria: [
    { n: 1, status: "met" as const, evidence: "test/retry.test.ts passes" },
    { n: 2, status: "unmet" as const, evidence: "the retry cap is not enforced" },
    { n: 3, status: "maintainer" as const, evidence: "check the TUI by hand" },
  ],
  findings: [
    {
      severity: "blocking" as const,
      kind: "correctness",
      criterion: 2,
      file: "src/retry.ts",
      line: 14,
      quote: "for (let i = 0; i < 10; i++) {",
      text: "The loop ignores the cap from the config.",
    },
    {
      severity: "advisory" as const,
      kind: "maintainability",
      text: "The helper could be named better.",
      unverified: true,
    },
    {
      severity: "blocking" as const,
      kind: "test",
      testEntry: 4,
      text: "No automated test for the cap.",
    },
  ],
  summary: "Criterion 2 is unmet; the cap is missing.",
  model: "claude-sonnet-5-5",
  usage: {
    inputTokens: 120_000,
    outputTokens: 8_000,
    cacheCreateTokens: 0,
    cacheReadTokens: 40_000,
    turns: 12,
    elapsedMs: 300_000,
  },
  commentUrl: "https://github.com/example/demo/pull/142#issuecomment-1",
  carried: false,
  override: { note: "Accepted for now, fix later.", at: "2026-10-17T09:00:00Z" },
};

const reviewSummary = {
  round: 2,
  commit: "4f2a9c1d",
  verdict: "blocked" as const,
  blocking: 2,
  advisory: 1,
  commentUrl: "https://github.com/example/demo/pull/142#issuecomment-1",
};

const storyPr = {
  number: 142,
  url: "https://github.com/example/demo/pull/142",
  state: "open" as const,
};

describe("review verdict (0019 section 14)", () => {
  it("parses a full review verdict", () => {
    expect(ReviewVerdict.safeParse(reviewVerdict).success).toBe(true);
  });

  it("parses a minimal review verdict without the optional fields", () => {
    const { commentUrl: _url, carried: _carried, override: _override, ...minimal } = reviewVerdict;
    expect(ReviewVerdict.safeParse(minimal).success).toBe(true);
  });

  it("rejects a verdict outside approved or blocked, and a finding of an unknown severity", () => {
    expect(ReviewVerdict.safeParse({ ...reviewVerdict, verdict: "maybe" }).success).toBe(false);
    const finding = { ...reviewVerdict.findings[0], severity: "fatal" };
    expect(ReviewVerdict.safeParse({ ...reviewVerdict, findings: [finding] }).success).toBe(false);
  });

  it("parses a verdict with the review field and an old verdict without it", () => {
    const old = {
      gate: ids.gate,
      run: ids.run,
      kind: "review",
      decision: "rejected",
      by: "rule",
      at: "2026-10-12T08:50:00Z",
    };
    expect(Verdict.safeParse(old).success).toBe(true);
    const withReview = Verdict.safeParse({ ...old, review: reviewVerdict });
    expect(withReview.success).toBe(true);
    expect(withReview.data?.review?.findings[1]?.unverified).toBe(true);
  });

  it("gate.decided parses with and without its review summary", () => {
    const old = { gate: ids.gate, decision: "approved", by: "maintainer" };
    expect(gateDecided.data.safeParse(old).success).toBe(true);
    const withReview = { ...old, review: reviewSummary };
    expect(gateDecided.data.safeParse(withReview).success).toBe(true);
  });

  it("parses a review summary and rejects a negative count", () => {
    expect(ReviewSummary.safeParse(reviewSummary).success).toBe(true);
    expect(ReviewSummary.safeParse({ ...reviewSummary, blocking: -1 }).success).toBe(false);
  });
});

describe("story PR (0019 section 3)", () => {
  it("parses StoryPr with each state, and rejects an unknown state", () => {
    for (const state of ["open", "merged", "closed"]) {
      expect(StoryPr.safeParse({ ...storyPr, state }).success).toBe(true);
    }
    expect(StoryPr.safeParse({ ...storyPr, state: "draft" }).success).toBe(false);
  });

  it("parses StoryView with pr, and StoryView without it", () => {
    expect(StoryView.safeParse({ ...storyView, pr: storyPr }).success).toBe(true);
    const parsed = StoryView.parse(storyView);
    expect(parsed.pr).toBeUndefined();
  });

  it("story.pr carries story, key and pr", () => {
    const event = findEvent("story.pr")?.data.safeParse(eventFixtures["story.pr"]);
    expect(event?.success).toBe(true);
    const payload = { story: "DIPO-21", key: ids.storyKey, pr: storyPr };
    expect(findEvent("story.pr")?.data.safeParse(payload).success).toBe(true);
    expect(findEvent("story.pr")?.data.safeParse({ story: "DIPO-21" }).success).toBe(false);
  });
});

describe("progress (0019 section 14)", () => {
  it("parses progress with and without the review round fields", () => {
    const withReview = { ...progress, reviewRoundCap: 3, reviewRoundsFailed: 1 };
    expect(Progress.safeParse(withReview).success).toBe(true);
    expect(Progress.safeParse(progress).success).toBe(true);
  });
});

describe("gate commands and office codes (0019 section 15)", () => {
  it("lists gate.approve and gate.reject as shipped commands", () => {
    const commands = contractCommands.filter(
      (command) => command.name === "gate.approve" || command.name === "gate.reject",
    );
    expect(commands.map((command) => command.name).toSorted()).toEqual([
      "gate.approve",
      "gate.reject",
    ]);
    for (const command of commands) expect(command.since).toBe(1);
  });

  it("exports the three review codes as office errors that are not retryable", () => {
    const codes = ["gate.notWaitingOnMaintainer", "gate.handMergeOnly", "gate.noteRequired"];
    const known: readonly string[] = OFFICE_ERROR_CODES;
    for (const code of codes) {
      expect(known).toContain(code);
      expect(engineError(code, "m").retryable).toBe(false);
    }
  });
});
