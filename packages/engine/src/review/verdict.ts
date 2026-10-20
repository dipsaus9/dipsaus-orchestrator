// The verdict of a review round, computed by code from a validated report (0019 section 5,
// decision B): `blocked` when a criterion is `unmet` or a validated blocking finding exists,
// otherwise `approved`. A criterion only the maintainer can check (`maintainer`) does not block;
// it makes the merge wait for them (section 11). Pure and deterministic.

import type { ReviewCriterionResult, ReviewFinding } from "@dipsaus-orchestrator/contract";

import type { ReviewReport } from "../workers/types";

import type { CheckedFinding } from "./validate";

export type ReviewDecision = "approved" | "blocked";

/** A judged review round: what is stored on the verdict and shown as `Verdict.review`. */
export interface JudgedReview {
  readonly verdict: ReviewDecision;
  readonly criteria: readonly ReviewCriterionResult[];
  /**
   * The findings as stored: blocking only when code checked its evidence; a blocking finding of a
   * kind that cannot block is advisory, and one whose evidence failed is advisory and unverified.
   */
  readonly findings: readonly ReviewFinding[];
  readonly summary: string;
  /** One line per finding code changed, and why; empty when it kept every finding as reported. */
  readonly notes: readonly string[];
}

function stored(checked: CheckedFinding): ReviewFinding {
  const { finding, check } = checked;
  const base: ReviewFinding = {
    severity: check.status === "blocking" ? "blocking" : "advisory",
    kind: finding.kind,
    ...(finding.criterion === undefined ? {} : { criterion: finding.criterion }),
    ...(finding.testEntry === undefined ? {} : { testEntry: finding.testEntry }),
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.quote === undefined ? {} : { quote: finding.quote }),
    text: finding.text,
  };
  return check.status === "failed" ? { ...base, unverified: true } : base;
}

/**
 * Pure: the verdict of a valid report whose findings `validateReport` checked. Call it after the
 * correction turn: a blocking finding whose evidence still fails is kept as advisory, unverified.
 */
export function judgeReview(
  report: ReviewReport,
  findings: readonly CheckedFinding[],
): JudgedReview {
  const criteria = report.criteria
    .map((entry) => ({ n: entry.n, status: entry.status, evidence: entry.evidence }))
    .toSorted((a, b) => a.n - b.n);
  const unmet = criteria.some((entry) => entry.status === "unmet");
  const blocking = findings.some((checked) => checked.check.status === "blocking");
  const notes = findings.flatMap((checked, index) => {
    const name = `finding ${index + 1} (${checked.finding.kind})`;
    if (checked.check.status === "demoted") {
      return [
        `${name}: marked blocking, stored as advisory; only scope, test, correctness and security findings block`,
      ];
    }
    if (checked.check.status === "failed") {
      return [`${name}: ${checked.check.problems.join("; ")}; kept as advisory, unverified`];
    }
    return [];
  });
  return {
    verdict: unmet || blocking ? "blocked" : "approved",
    criteria,
    findings: findings.map(stored),
    summary: report.summary,
    notes,
  };
}

/** The count of blocking and advisory findings, as the review summary of `gate.decided` has it. */
export function findingCounts(findings: readonly ReviewFinding[]): {
  blocking: number;
  advisory: number;
} {
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  return { blocking, advisory: findings.length - blocking };
}
