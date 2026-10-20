// The verdict computed by code from a validated report (0019 section 5, DIPO-146 AC #2).

import { describe, expect, it } from "bun:test";

import { parseStoryDiff } from "../../src/review/diff";
import { type ReviewFacts, validateReport } from "../../src/review/validate";
import { findingCounts, judgeReview } from "../../src/review/verdict";
import type { ReviewFinding, ReviewReport } from "../../src/workers/types";

const FACTS: ReviewFacts = {
  criteria: [1, 2],
  testPlan: { entries: [{ kind: "automated", check: "a unit test" }] },
  diff: parseStoryDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = a - 1;
`),
};

const MET: ReviewReport["criteria"] = [
  { n: 2, status: "met", evidence: "shown" },
  { n: 1, status: "met", evidence: "" },
];

/** The verdict of a report, as after its correction turn. */
function judge(findings: ReviewFinding[], criteria = MET) {
  const report: ReviewReport = { criteria, findings, summary: "Summary." };
  const checked = validateReport(report, FACTS);
  if (!checked.valid) throw new Error(checked.problems.join("; "));
  return judgeReview(report, checked.findings);
}

const security: ReviewFinding = {
  severity: "blocking",
  kind: "security",
  file: "a.ts",
  line: 2,
  quote: "const b = a - 1;",
  text: "Off by one.",
};

describe("judgeReview", () => {
  it("approves when every criterion is met or the maintainer's and no finding blocks", () => {
    const judged = judge(
      [{ severity: "advisory", kind: "other", text: "A nit." }],
      [
        { n: 1, status: "met", evidence: "" },
        { n: 2, status: "maintainer", evidence: "needs a hand test" },
      ],
    );
    expect(judged).toEqual({
      verdict: "approved",
      criteria: [
        { n: 1, status: "met", evidence: "" },
        { n: 2, status: "maintainer", evidence: "needs a hand test" },
      ],
      findings: [{ severity: "advisory", kind: "other", text: "A nit." }],
      summary: "Summary.",
      notes: [],
    });
  });

  it("blocks on an unmet criterion, with no finding", () => {
    const judged = judge(
      [],
      [
        { n: 1, status: "unmet", evidence: "no migration" },
        { n: 2, status: "met", evidence: "" },
      ],
    );
    expect(judged.verdict).toBe("blocked");
    expect(judged.criteria.map((entry) => entry.n)).toEqual([1, 2]);
  });

  it("blocks on a validated blocking finding and on a test finding naming an automated entry", () => {
    expect(judge([security])).toMatchObject({ verdict: "blocked", findings: [security] });
    expect(
      judge([{ severity: "blocking", kind: "test", testEntry: 1, text: "No test." }]).verdict,
    ).toBe("blocked");
  });

  it("keeps blocking maintainability and other findings as advisory and approves", () => {
    const judged = judge([
      { severity: "blocking", kind: "maintainability", file: "a.ts", text: "Hard to read." },
      { severity: "blocking", kind: "other", text: "Rename it." },
    ]);
    expect(judged.verdict).toBe("approved");
    expect(judged.findings).toEqual([
      { severity: "advisory", kind: "maintainability", file: "a.ts", text: "Hard to read." },
      { severity: "advisory", kind: "other", text: "Rename it." },
    ]);
    expect(judged.notes).toEqual([
      "finding 1 (maintainability): marked blocking, stored as advisory; only scope, test, correctness and security findings block",
      "finding 2 (other): marked blocking, stored as advisory; only scope, test, correctness and security findings block",
    ]);
    expect(findingCounts(judged.findings)).toEqual({ blocking: 0, advisory: 2 });
  });

  it("keeps a blocking finding whose evidence still fails as advisory and unverified, and approves", () => {
    const judged = judge([{ ...security, quote: "const b = a + 1;" }, security]);
    expect(judged.verdict).toBe("blocked");
    const only = judge([{ ...security, quote: "const b = a + 1;" }]);
    expect(only).toMatchObject({
      verdict: "approved",
      findings: [
        { ...security, quote: "const b = a + 1;", severity: "advisory", unverified: true },
      ],
      notes: [
        "finding 1 (security): the quote differs from line 2 of a.ts; kept as advisory, unverified",
      ],
    });
    expect(findingCounts(judged.findings)).toEqual({ blocking: 1, advisory: 1 });
  });
});
