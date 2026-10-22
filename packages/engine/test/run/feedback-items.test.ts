// Send-once feedback items (DIPO-148; 0019 section 8): review item signatures over the identifying
// fields only, the reject item's stored shape, one message per head with repeats marked and
// advisories optional, and the send-once and same-failure facts of `feedback_items` on a migrated
// state database.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  collapseWhitespace,
  FEEDBACK_ITEM_MAX,
  fixRoundMessage,
  rejectFeedbackItem,
  rejectSignature,
  reviewFeedbackItems,
  reviewFindingSignature,
} from "../../src/prompts";
import type { FixItem } from "../../src/prompts/feedback";
import {
  feedbackItems,
  markFeedbackSent,
  nextFixRound,
  planFeedback,
  recordIntent,
  sameFailureAgain,
  storeFeedbackItems,
} from "../../src/run";
import { type RoundsWorld, roundsWorld, storyRun } from "./rounds-helpers";

const QUOTE = "export const total = (a: number, b: number) => a - b;";

const finding = (overrides: Record<string, unknown> = {}) => ({
  severity: "blocking" as const,
  kind: "correctness",
  file: "src/greet.ts",
  line: 2,
  quote: QUOTE,
  text: "total subtracts instead of adding.",
  ...overrides,
});

/** The signature of a blocking test finding on test-plan entry `entry`. */
const test = (entry: number, text: string) =>
  reviewFindingSignature({ severity: "blocking", kind: "test", testEntry: entry, text });

/** The items of a verdict whose criterion 2 is unmet with `evidence`. */
const unmetItems = (evidence: string) =>
  reviewFeedbackItems({
    criteria: [
      { n: 1, status: "met", evidence: "fine" },
      { n: 2, status: "unmet", evidence },
    ],
    findings: [],
  });

describe("review item signatures (0019 section 8)", () => {
  it("ignore the reviewer's free text and the line number, and collapse whitespace in quotes", () => {
    const base = reviewFindingSignature(finding());
    expect(reviewFindingSignature(finding({ text: "It should add, not subtract." }))).toBe(base);
    expect(reviewFindingSignature(finding({ line: 3 }))).toBe(base);
    expect(
      reviewFindingSignature(
        finding({ quote: "  export const total =\t(a: number,  b: number) =>\n a - b;  " }),
      ),
    ).toBe(base);
    expect(collapseWhitespace("  a \t b\n\nc ")).toBe("a b c");
    // Another kind, file or quote is another failure.
    expect(reviewFindingSignature(finding({ kind: "security" }))).not.toBe(base);
    expect(reviewFindingSignature(finding({ file: "src/other.ts" }))).not.toBe(base);
    expect(reviewFindingSignature(finding({ quote: "export const total = 0;" }))).not.toBe(base);
  });

  it("key a test finding on its kind and test-plan entry, and an unmet criterion on its number and status", () => {
    expect(test(1, "no test for the greeting")).toBe(test(1, "the greeting has no test"));
    expect(test(1, "x")).not.toBe(test(2, "x"));
    const [first] = unmetItems("nothing checks an empty name.");
    const [second] = unmetItems("an empty name is not refused.");
    expect(unmetItems("x")).toHaveLength(1);
    expect(first?.signature).toBe(second?.signature);
    expect(first?.signature).not.toBe(
      reviewFeedbackItems({ criteria: [{ n: 3, status: "unmet", evidence: "" }], findings: [] })[0]
        ?.signature,
    );
  });

  it("make one item per unmet criterion and blocking finding, with the evidence, and no item for an advisory", () => {
    const items = reviewFeedbackItems(
      {
        criteria: [{ n: 2, status: "unmet", evidence: "nothing checks an empty name." }],
        findings: [
          finding(),
          { severity: "advisory", kind: "maintainability", text: "name the helper better." },
        ],
      },
      (n) => (n === 2 ? "The CLI refuses an empty name." : undefined),
    );
    expect(items.map((item) => item.source)).toEqual(["review", "review"]);
    expect(items[0]?.text).toBe(
      "The reviewer found acceptance criterion #2 unmet: The CLI refuses an empty name.\nEvidence: nothing checks an empty name.",
    );
    expect(items[1]?.text).toBe(
      `The reviewer found a blocking correctness problem at src/greet.ts:2.\nQuoted line: ${QUOTE}\ntotal subtracts instead of adding.`,
    );
  });
});

describe("a maintainer reject item (0019 sections 8 and 11)", () => {
  it("holds the note verbatim, keyed on the gate id", () => {
    const note = "Keep the old flag working:\n  `shop greet --name` must still print Hi.";
    const item = rejectFeedbackItem({ gateId: "gat-7", note });
    expect(item).toEqual({
      source: "reject",
      signature: rejectSignature("gat-7"),
      text: `The maintainer rejected this change with this note:\n${note}`,
    });
    expect(item.signature).toBe("gate:gat-7");
    // Another reject of the same note is another gate, so it is sent again.
    expect(rejectFeedbackItem({ gateId: "gat-8", note }).signature).not.toBe(item.signature);
  });
});

describe("the fix round's one message", () => {
  it("carries every item for the head, marks a repeat and lists advisories as optional", () => {
    const text = fixRoundMessage({
      head: "e".repeat(40),
      items: [
        { source: "review", text: "The reviewer found a blocking problem.", repeat: false },
        { source: "ci", text: "Required check ci-ok failed on the pushed head.", repeat: true },
      ],
      advisories: ["- maintainability: name the helper better."],
    });
    expect(text).toContain(`Your pushed commit ${"e".repeat(12)} got feedback`);
    expect(text).toContain("Item 1 (review):\nThe reviewer found a blocking problem.");
    expect(text).toContain(
      "Item 2 (ci, still failing after your last change):\nRequired check ci-ok failed",
    );
    expect(text).toContain("Optional: the reviewer also left these advisory findings.");
    expect(text).toContain("- maintainability: name the helper better.");
    // No advisories: no optional list.
    expect(fixRoundMessage({ head: "e".repeat(40), items: [], advisories: [] })).not.toContain(
      "Optional",
    );
  });
});

let w: RoundsWorld;

beforeEach(async () => {
  w = await roundsWorld("feedback-items-");
});

afterEach(() => w.close());

const ci = (signature: string): FixItem => ({
  source: "ci",
  signature,
  text: `Required check ${signature} failed.`,
});

/** Stores `items` for `head` as one fix round with its steer intent, as a round is queued. */
function send(run: ReturnType<typeof storyRun>["run"], head: string, items: readonly FixItem[]) {
  return w.office.immediate(() => {
    const planned = planFeedback(w.office, run, head, items);
    const same = sameFailureAgain(w.office, run, planned);
    const intentId = recordIntent(w.office, run, "steer", `fix-round ${head}`, w.t.clock.now());
    const stored = storeFeedbackItems(w.office, run, {
      intentId,
      head,
      round: nextFixRound(w.office, run),
      items: planned,
      at: w.t.clock.now(),
    });
    return { planned, same, intentId, stored };
  });
}

describe("send-once per head", () => {
  it("stores an item once per head, marks the same signature on a later head a repeat, and flags two CI sends in a row", () => {
    const { run } = storyRun(w, { story: "DIPO-1", reviewRoundCap: 3 });
    const first = send(run, "h1", [ci("ci-ok"), ci("lint")]);
    expect(first.planned.map((item) => [item.signature, item.repeat])).toEqual([
      ["ci-ok", false],
      ["lint", false],
    ]);
    expect(first.same).toBe(false);
    expect(first.stored.map((item) => [item.round, item.sentAt])).toEqual([
      [1, null],
      [1, null],
    ]);
    // The same head again (a second poll, a second CI run): nothing new.
    expect(w.office.immediate(() => planFeedback(w.office, run, "h1", [ci("ci-ok")]))).toEqual([]);
    // A later head with the same CI signature: a repeat, and the same failure twice in a row.
    const second = send(run, "h2", [ci("ci-ok"), ci("types")]);
    expect(second.planned.map((item) => [item.signature, item.repeat])).toEqual([
      ["ci-ok", true],
      ["types", false],
    ]);
    expect(second.same).toBe(true);
    expect(second.stored.map((item) => item.round)).toEqual([2, 2]);
    // A review item repeated is no same-failure signal: only verify and CI signatures count.
    const review: FixItem = { source: "review", signature: "r1", text: "unmet" };
    send(run, "h3", [review]);
    expect(send(run, "h4", [review]).same).toBe(false);
    w.office.immediate(() => markFeedbackSent(w.office, run, first.intentId, 77));
    expect(feedbackItems(w.office, run).map((item) => [item.head, item.sentAt])).toEqual([
      ["h1", 77],
      ["h1", 77],
      ["h2", null],
      ["h2", null],
      ["h3", null],
      ["h4", null],
    ]);
  });

  it("keeps a stored item within the per-item budget", () => {
    const { run } = storyRun(w, { story: "DIPO-1", reviewRoundCap: 3 });
    const long: FixItem = { source: "ci", signature: "long", text: "x".repeat(10_000) };
    const [stored] = send(run, "h1", [long]).stored;
    expect(stored?.text.length).toBeLessThanOrEqual(FEEDBACK_ITEM_MAX);
    expect(stored?.text).toContain("[dipo: cut");
  });
});
