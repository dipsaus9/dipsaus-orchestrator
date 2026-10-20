// Validation of a reviewer report against the story's criteria, test plan and diff (0019 section
// 5, DIPO-146 AC #1).

import { describe, expect, it } from "bun:test";

import { parseStoryDiff } from "../../src/review/diff";
import { evidenceProblems, type ReviewFacts, validateReport } from "../../src/review/validate";
import type { ReviewFinding, ReviewReport } from "../../src/workers/types";

const DIFF = `diff --git a/src/total.ts b/src/total.ts
index 1111111..2222222 100644
--- a/src/total.ts
+++ b/src/total.ts
@@ -10,4 +10,5 @@ export function total(a: number, b: number): number {
   const sum = a + b;
-  return sum;
+  const total = a - b;
+  return total;
 }

diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const old = 1;
-export const older = 2;
`;

const FACTS: ReviewFacts = {
  criteria: [1, 2],
  testPlan: {
    entries: [
      { kind: "automated", check: "a unit test for total" },
      { kind: "manual", check: "the maintainer runs dipo by hand" },
    ],
  },
  diff: parseStoryDiff(DIFF),
};

const MET: ReviewReport["criteria"] = [
  { n: 1, status: "met", evidence: "" },
  { n: 2, status: "met", evidence: "the test exists" },
];

function report(findings: ReviewFinding[], criteria = MET): ReviewReport {
  return { criteria, findings, summary: "Reviewed." };
}

const correctness: ReviewFinding = {
  severity: "blocking",
  kind: "correctness",
  file: "src/total.ts",
  line: 12,
  quote: "  const total = a - b;  ",
  text: "Subtracts instead of adds.",
};

/** A blocking test finding naming `testEntry`, or no entry. */
function test(testEntry?: number): ReviewFinding {
  return {
    severity: "blocking",
    kind: "test",
    ...(testEntry === undefined ? {} : { testEntry }),
    text: "The test is missing.",
  };
}

describe("parseStoryDiff", () => {
  it("keeps the new-side lines of each hunk by number and no line of a deleted file", () => {
    const file = FACTS.diff.files.get("src/total.ts");
    expect([...(file?.lines ?? new Map()).entries()]).toEqual([
      [10, "  const sum = a + b;"],
      [11, "  const total = a - b;"],
      [12, "  return total;"],
      [13, "}"],
      [14, ""],
    ]);
    expect(FACTS.diff.files.has("src/old.ts")).toBe(false);
  });

  it("reads a quoted path and a hunk without a count", () => {
    const diff =
      parseStoryDiff(`diff --git "a/sp\\303\\251cial file.ts" "b/sp\\303\\251cial file.ts"
--- "a/sp\\303\\251cial file.ts"
+++ "b/sp\\303\\251cial file.ts"
@@ -1 +1 @@
-old
+new
`);
    expect([...diff.files.keys()]).toEqual(["spécial file.ts"]);
    expect(diff.files.get("spécial file.ts")?.lines.get(1)).toBe("new");
  });
});

describe("validateReport", () => {
  it("accepts one entry per criterion and checks a quoted blocking finding against the diff", () => {
    const fixed = { ...correctness, line: 11 };
    expect(validateReport(report([fixed]), FACTS)).toEqual({
      valid: true,
      findings: [{ finding: fixed, check: { status: "blocking" } }],
    });
  });

  it("refuses a report with a missing criterion, an extra one or a repeated one", () => {
    expect(validateReport(report([], [MET[0] as ReviewReport["criteria"][number]]), FACTS)).toEqual(
      { valid: false, problems: ["criteria has no entry for criterion #2"] },
    );
    expect(
      validateReport(
        report(
          [],
          [...MET, { n: 3, status: "met", evidence: "" }, { n: 1, status: "met", evidence: "" }],
        ),
        FACTS,
      ),
    ).toEqual({
      valid: false,
      problems: [
        "criteria names #3, which the story does not have",
        "criteria names #1 more than once",
      ],
    });
  });

  it("refuses unmet and maintainer entries without evidence, and a summary over its cap", () => {
    const result = validateReport(
      {
        criteria: [
          { n: 1, status: "unmet", evidence: "  " },
          { n: 2, status: "maintainer", evidence: "" },
        ],
        findings: [],
        summary: "x".repeat(1_501),
      },
      FACTS,
    );
    expect(result).toEqual({
      valid: false,
      problems: [
        "criterion #1 is unmet without evidence",
        "criterion #2 is maintainer without evidence",
        "summary is 1501 characters, over 1500 characters",
      ],
    });
  });

  it("fails a quote that differs from the line it names", () => {
    const result = validateReport(report([correctness]), FACTS);
    expect(result.valid && result.findings[0]?.check).toEqual({
      status: "failed",
      problems: ["the quote differs from line 12 of src/total.ts"],
    });
  });

  it("fails a line outside the story's hunks, a path the diff does not change, and missing evidence", () => {
    const findings: ReviewFinding[] = [
      { ...correctness, kind: "security", line: 3, quote: "import x;" },
      { ...correctness, kind: "scope", file: "src/other.ts" },
      { ...correctness, file: "src/old.ts", line: 1, quote: "export const old = 1;" },
      { severity: "blocking", kind: "correctness", text: "Somewhere." },
      { severity: "blocking", kind: "correctness", file: "src/total.ts", text: "No line." },
      {
        severity: "blocking",
        kind: "correctness",
        file: "src/total.ts",
        line: 11,
        text: "No quote.",
      },
    ];
    const result = validateReport(report(findings), FACTS);
    if (!result.valid) throw new Error("expected a valid report");
    expect(evidenceProblems(result.findings)).toEqual([
      "finding 1 (security): line 3 of src/total.ts is not inside a hunk of the story's diff",
      "finding 2 (scope): src/other.ts is not a changed path of the story's diff",
      // A deleted file has no line at the reviewed commit.
      "finding 3 (correctness): src/old.ts is not a changed path of the story's diff",
      "finding 4 (correctness): it names no changed file",
      "finding 5 (correctness): it names no line of src/total.ts",
      "finding 6 (correctness): it quotes no line of src/total.ts:11",
    ]);
  });

  it("fails a test finding that names a manual entry, an entry the plan does not have, or none", () => {
    const result = validateReport(report([test(1), test(2), test(3), test()]), FACTS);
    if (!result.valid) throw new Error("expected a valid report");
    expect(result.findings.map((checked) => checked.check)).toEqual([
      { status: "blocking" },
      { status: "failed", problems: ["test-plan entry #2 is manual, not automated"] },
      { status: "failed", problems: ["the test plan has no entry #3"] },
      { status: "failed", problems: ["it names no test-plan entry"] },
    ]);
    // A story whose test plan is not applicable has no entry a test finding could name.
    const none = validateReport(report([test(1)]), {
      ...FACTS,
      testPlan: { not_applicable: "docs only" },
    });
    expect(none.valid && none.findings[0]?.check).toEqual({
      status: "failed",
      problems: ["the test plan has no entry #1"],
    });
  });

  it("stores blocking maintainability and other findings as advisory by rule, and checks no advisory evidence", () => {
    const findings: ReviewFinding[] = [
      { severity: "blocking", kind: "maintainability", text: "Long function." },
      { severity: "blocking", kind: "other", text: "Odd name." },
      { severity: "advisory", kind: "correctness", file: "nowhere.ts", text: "Maybe." },
    ];
    const result = validateReport(report(findings), FACTS);
    if (!result.valid) throw new Error("expected a valid report");
    expect(result.findings.map((checked) => checked.check)).toEqual([
      { status: "demoted" },
      { status: "demoted" },
      { status: "advisory" },
    ]);
    expect(evidenceProblems(result.findings)).toEqual([]);
  });
});
