// Validation of a reviewer report by code, at the reviewed commit (0019 section 5). The report is
// valid only with exactly one criteria entry per criterion number of the story and evidence for
// every `unmet` and `maintainer` entry. Each blocking finding is then checked:
//
// - `scope`, `security` and `correctness` need `file` (a changed path), `line` (inside a hunk of
//   the story's diff) and `quote` (equal to that line after trimming whitespace);
// - `test` needs `testEntry`, the number of an automated entry of the story's test plan;
// - `maintainability` and `other` never block: marked blocking, they are stored as advisory by
//   rule, without a correction turn.
//
// A blocking finding whose evidence fails gets one correction turn (DIPO-219); after it, the
// verdict keeps it as advisory, marked unverified. Pure and deterministic.

import type { TestPlan } from "@dipsaus-orchestrator/contract";

import { REVIEW_SUMMARY_MAX, type ReviewFinding, type ReviewReport } from "../workers/types";

import type { StoryDiff } from "./diff";

/** What a report is checked against: the story's facts and its diff at the reviewed commit. */
export interface ReviewFacts {
  /** The story's criterion numbers, as Backlog.md numbers them. */
  readonly criteria: readonly number[];
  /** The story's test plan; entries are numbered from 1 in field block order. */
  readonly testPlan: TestPlan | undefined;
  /** The diff from the merge base to the reviewed commit, without the story's task file. */
  readonly diff: StoryDiff;
}

/** The kinds a blocking finding may have (0002, 0019 decisions 6 and 7). */
export const BLOCKING_KINDS: ReadonlySet<string> = new Set([
  "scope",
  "test",
  "correctness",
  "security",
]);

/** The kinds whose blocking evidence is a quoted line of the diff. */
const QUOTED_KINDS: ReadonlySet<string> = new Set(["scope", "correctness", "security"]);

/**
 * How code judged one finding: `blocking` with its evidence checked; `advisory` as the reviewer
 * marked it; `demoted`, a blocking finding of a kind that cannot block; `failed`, a blocking
 * finding whose evidence did not check out, with the reasons.
 */
export type FindingCheck =
  | { readonly status: "blocking" }
  | { readonly status: "advisory" }
  | { readonly status: "demoted" }
  | { readonly status: "failed"; readonly problems: readonly string[] };

export interface CheckedFinding {
  readonly finding: ReviewFinding;
  readonly check: FindingCheck;
}

export type ReportCheck =
  | {
      /** Not a report the verdict can use: one correction turn, then as a crash (section 4). */
      readonly valid: false;
      readonly problems: readonly string[];
    }
  | {
      readonly valid: true;
      /** Every finding in report order, with how code judged it. */
      readonly findings: readonly CheckedFinding[];
    };

const blank = (text: string | undefined): boolean => text === undefined || text.trim() === "";

/** The report-level problems: criteria entries and the summary length. Empty when valid. */
function reportProblems(report: ReviewReport, facts: ReviewFacts): string[] {
  const problems: string[] = [];
  const known = new Set(facts.criteria);
  const seen = new Set<number>();
  for (const entry of report.criteria) {
    if (!known.has(entry.n)) {
      problems.push(`criteria names #${entry.n}, which the story does not have`);
    } else if (seen.has(entry.n)) {
      problems.push(`criteria names #${entry.n} more than once`);
    }
    seen.add(entry.n);
    if (entry.status !== "met" && blank(entry.evidence)) {
      problems.push(`criterion #${entry.n} is ${entry.status} without evidence`);
    }
  }
  for (const n of facts.criteria) {
    if (!seen.has(n)) problems.push(`criteria has no entry for criterion #${n}`);
  }
  if (report.summary.length > REVIEW_SUMMARY_MAX) {
    problems.push(
      `summary is ${report.summary.length} characters, over ${REVIEW_SUMMARY_MAX} characters`,
    );
  }
  return problems;
}

/** Why a quoted finding's evidence fails; empty when it points at a quoted line of the diff. */
function quoteProblems(finding: ReviewFinding, diff: StoryDiff): string[] {
  if (blank(finding.file)) return ["it names no changed file"];
  const file = diff.files.get(finding.file ?? "");
  if (file === undefined) return [`${finding.file} is not a changed path of the story's diff`];
  if (finding.line === undefined) return [`it names no line of ${file.path}`];
  const text = file.lines.get(finding.line);
  if (text === undefined) {
    return [`line ${finding.line} of ${file.path} is not inside a hunk of the story's diff`];
  }
  if (finding.quote === undefined) return [`it quotes no line of ${file.path}:${finding.line}`];
  if (finding.quote.trim() !== text.trim()) {
    return [`the quote differs from line ${finding.line} of ${file.path}`];
  }
  return [];
}

/** Why a test finding's evidence fails; empty when it names an automated test-plan entry. */
function testProblems(finding: ReviewFinding, plan: TestPlan | undefined): string[] {
  if (finding.testEntry === undefined) return ["it names no test-plan entry"];
  const entry = plan?.entries?.[finding.testEntry - 1];
  if (finding.testEntry < 1 || entry === undefined) {
    return [`the test plan has no entry #${finding.testEntry}`];
  }
  if (entry.kind !== "automated") {
    return [`test-plan entry #${finding.testEntry} is ${entry.kind}, not automated`];
  }
  return [];
}

function checkFinding(finding: ReviewFinding, facts: ReviewFacts): FindingCheck {
  if (finding.severity !== "blocking") return { status: "advisory" };
  if (!BLOCKING_KINDS.has(finding.kind)) return { status: "demoted" };
  const problems = QUOTED_KINDS.has(finding.kind)
    ? quoteProblems(finding, facts.diff)
    : testProblems(finding, facts.testPlan);
  return problems.length === 0 ? { status: "blocking" } : { status: "failed", problems };
}

/** Pure: checks the report against the story's facts and diff (0019 section 5). */
export function validateReport(report: ReviewReport, facts: ReviewFacts): ReportCheck {
  const problems = reportProblems(report, facts);
  if (problems.length > 0) return { valid: false, problems };
  return {
    valid: true,
    findings: report.findings.map((finding) => ({ finding, check: checkFinding(finding, facts) })),
  };
}

/** The findings whose blocking evidence failed, numbered as in the report: the correction turn. */
export function evidenceProblems(findings: readonly CheckedFinding[]): string[] {
  return findings.flatMap((checked, index) =>
    checked.check.status === "failed"
      ? [`finding ${index + 1} (${checked.finding.kind}): ${checked.check.problems.join("; ")}`]
      : [],
  );
}
