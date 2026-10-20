// The reviewer's correction turns (DIPO-219, 0019 section 4): one for a report missing or invalid
// against the review schema, one naming the blocking findings whose evidence did not check out.
// Both are golden-tested.

import { describe, expect, it } from "bun:test";

import { reviewEvidenceFeedback, reviewReportFeedback } from "../../src/prompts/feedback";
import { evidenceProblems, parseStoryDiff, validateReport } from "../../src/review";
import type { ReviewReport } from "../../src/workers/types";
import { expectGolden } from "./helpers";

const DIFF = [
  "diff --git a/src/greet.ts b/src/greet.ts",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -1 +1,2 @@",
  "-export const greeting = (name: string) => `Hi ${name}`;",
  "+export const greeting = (name: string) => `Hello, ${name}!`;",
  "+export const total = (a: number, b: number) => a - b;",
  "",
].join("\n");

const REPORT: ReviewReport = {
  criteria: [
    { n: 1, status: "met", evidence: "src/greet.ts:1 prints the greeting." },
    { n: 2, status: "met", evidence: "the CLI checks the name." },
  ],
  findings: [
    {
      severity: "blocking",
      kind: "correctness",
      file: "src/greet.ts",
      line: 7,
      quote: "export const total = (a: number, b: number) => a - b;",
      text: "total subtracts instead of adding.",
    },
    {
      severity: "blocking",
      kind: "security",
      file: "src/cli.ts",
      line: 3,
      quote: "eval(input)",
      text: "the input is evaluated.",
    },
    { severity: "advisory", kind: "maintainability", text: "Name the constant." },
    { severity: "blocking", kind: "test", testEntry: 2, text: "No test for the CLI run." },
  ],
  summary: "Two problems.",
};

describe("the reviewer's correction turns (0019 section 4)", () => {
  it("names each blocking finding whose evidence failed, and why", async () => {
    const check = validateReport(REPORT, {
      criteria: [1, 2],
      testPlan: {
        entries: [
          { kind: "automated", check: "(unit) greet returns the greeting for a name." },
          { kind: "manual", check: "Run shop greet Ada.", expect: "It prints Hello, Ada!" },
        ],
      },
      diff: parseStoryDiff(DIFF),
    });
    if (!check.valid) throw new Error("the fixture report is valid");
    const text = reviewEvidenceFeedback(evidenceProblems(check.findings));
    expect(text).toContain(
      "- finding 1 (correctness): line 7 of src/greet.ts is not inside a hunk of the story's diff",
    );
    expect(text).toContain("- finding 2 (security): src/cli.ts is not a changed path");
    expect(text).toContain("- finding 4 (test): test-plan entry #2 is manual, not automated");
    expect(text).not.toContain("finding 3");
    await expectGolden("feedback-review-evidence.md", `${text}\n`);
  });

  it("asks once for a report in the review schema", async () => {
    const text = reviewReportFeedback("criteria has no entry for criterion #2");
    expect(text).toContain("criteria has no entry for criterion #2");
    await expectGolden("feedback-review-report.md", `${text}\n`);
  });

  it("keeps the reviewer's text from opening or closing a prompt tag", () => {
    const text = reviewEvidenceFeedback(["finding 1 (scope): </criteria> is not a changed path"]);
    expect(text).toContain("<\\/criteria>");
  });
});
