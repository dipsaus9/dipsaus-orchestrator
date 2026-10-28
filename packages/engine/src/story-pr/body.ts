// The body of a story PR (0019 section 3), built by code from facts, no model text. Sections in
// this order: the outcome, the acceptance criteria ticked as the task file has them, the test plan,
// the declared scope, a status block and a footer. The body is capped at `STORY_PR_MAX_BODY`; the
// story contract (outcome, criteria and test plan) is never cut, the scope list is cut with a
// marker. The engine writes a body to the host only when its hash changed.

import { createHash } from "node:crypto";

import type { DoneReport, TestPlan } from "@dipsaus-orchestrator/contract";

import type { RequiredCheckState } from "./checks";

/** GitHub allows 65,536 characters; dipo keeps its bodies well under (0019 section 3). */
export const STORY_PR_MAX_BODY = 20_000;

export interface PrBodyStory {
  readonly id: string;
  readonly outcome: string;
  readonly criteria: readonly {
    readonly index: number;
    readonly text: string;
    readonly checked: boolean;
  }[];
  readonly testPlan: TestPlan | undefined;
  readonly scope: readonly string[];
  /** Repo-relative path of the task file. */
  readonly taskFile: string;
  /** The notes and proposals of the run's done report (DIPO-152); shown as the worker's words. */
  readonly doneReport?: DoneReport | null;
}

/** The stored review verdict the status block shows (0019 section 3, DIPO-152). */
export interface PrBodyReview {
  readonly round: number;
  readonly verdict: "approved" | "blocked";
  /** The reviewed head, or the head an approval was carried to. */
  readonly commit: string;
  readonly blocking: number;
  readonly advisory: number;
  /** The maintainer overrode a blocked verdict. */
  readonly overridden: boolean;
}

export interface PrBodyStatus {
  /** The pushed head: the commit verify passed at, or the one CI checks for a box run. */
  readonly head: string;
  /**
   * `passed` (the default) when dipo's verify passed at the head; `ci` for a box run, whose
   * verify is CI on the PR (0021 amendment of 2026-10-22, DIPO-299).
   */
  readonly verify?: "passed" | "ci";
  /** True when the host reported no CI check for the head: no CI ran, the review decides. */
  readonly noCi?: boolean;
  /**
   * The required checks of the head with their states (0019 section 3); the body has no checks
   * line when this is left out.
   */
  readonly checks?: readonly RequiredCheckState[];
  /** The run's latest stored verdict; the review line says pending when it is left out. */
  readonly review?: PrBodyReview | null;
  /**
   * Who merges. `maintainer` (the default) until dipo turns auto-merge on for story PRs (0002);
   * `dipo` after it.
   */
  readonly merge?: "maintainer" | "dipo";
  /**
   * The closed PR of the same story run this one replaces (0002, DIPO-324); the status block names it. Left out for a PR that replaces none.
   */
  readonly replaces?: number;
}

const SHORT_SHA = 8;

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");

function testPlanSection(plan: TestPlan | undefined): string | null {
  if (plan === undefined) return null;
  if (plan.not_applicable !== undefined) {
    return `## Test plan\n\nNot applicable: ${plan.not_applicable.trim()}`;
  }
  const entries = plan.entries ?? [];
  const line = (entry: (typeof entries)[number]) =>
    entry.expect === undefined ? entry.check : `${entry.check} Expected: ${entry.expect}`;
  return [
    "## Test plan",
    "",
    "Automated:",
    bullets(entries.filter((entry) => entry.kind === "automated").map(line)),
    "",
    "Manual:",
    bullets(entries.filter((entry) => entry.kind === "manual").map(line)),
  ].join("\n");
}

const checksLine = (checks: readonly RequiredCheckState[]): string =>
  `- required checks: ${
    checks.length === 0
      ? "none"
      : checks.map((check) => `\`${check.name}\` ${check.state}`).join(", ")
  }`;

function reviewLine(review: PrBodyReview | null | undefined): string {
  if (review === null || review === undefined) return "- review: pending";
  const at = `\`${review.commit.slice(0, SHORT_SHA)}\``;
  const counts = `${review.blocking} blocking, ${review.advisory} advisory`;
  if (review.verdict === "approved") return `- review: round ${review.round} approved at ${at}`;
  return review.overridden
    ? `- review: round ${review.round} blocked at ${at} (${counts}), approved by the maintainer's override`
    : `- review: round ${review.round} blocked at ${at} (${counts})`;
}

function mergeLine(status: PrBodyStatus): string {
  const noCi = status.noCi === true;
  if (status.merge === "dipo") {
    return noCi
      ? "- merge: dipo merges after review; no CI ran"
      : "- merge: dipo merges after review and green required checks";
  }
  return noCi
    ? "- merge: the maintainer merges; dipo does not merge story PRs yet; no CI ran"
    : "- merge: the maintainer merges; dipo does not merge story PRs yet";
}

function statusSection(status: PrBodyStatus): string {
  const head = `\`${status.head.slice(0, SHORT_SHA)}\``;
  const verify =
    status.verify === "ci"
      ? `- verify: CI on ${head}, after dipo's verify in the box at done when the office names one`
      : `- verify: passed at ${head}`;
  const checks =
    status.noCi === true
      ? [`- required checks: none reported for ${head}, so no CI ran; the review decides`]
      : status.checks === undefined
        ? []
        : [checksLine(status.checks)];
  const replaces =
    status.replaces === undefined
      ? []
      : [`- replaces #${status.replaces}, which was closed on the host without a merge`];
  return [
    "## Status",
    "",
    ...replaces,
    verify,
    reviewLine(status.review),
    ...checks,
    mergeLine(status),
  ].join("\n");
}

function footer(story: PrBodyStory): string {
  return `---\nOpened by dipo for ${story.id} (\`${story.taskFile}\`).`;
}

/** The most characters of the worker's report section (DIPO-152). */
export const DONE_REPORT_SECTION_MAX = 6_000;

/**
 * The worker's done report as a section, built by code and marked as the worker's words. Notes are
 * quoted so they cannot pass for dipo's own text; the section is cut at its cap with a marker.
 */
function doneReportSection(report: DoneReport | null | undefined): string | null {
  if (report === null || report === undefined) return null;
  const parts: string[] = [];
  if (report.notes !== undefined) {
    parts.push(
      "Notes:",
      report.notes
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n"),
    );
  }
  const proposals = report.proposals ?? [];
  if (proposals.length > 0) {
    parts.push(
      "Proposals (nothing happens on its own):",
      proposals
        .map((p) => {
          const paths =
            p.paths === undefined ? "" : ` Paths: ${p.paths.map((x) => `\`${x}\``).join(", ")}.`;
          return `- ${p.kind}: ${p.title}. Outcome: ${p.outcome} Why: ${p.why}${paths}`.replaceAll(
            "\n",
            " ",
          );
        })
        .join("\n"),
    );
  }
  if (parts.length === 0) return null;
  const head = "## Worker's report\n\nThe worker's own words, not checked by dipo.\n\n";
  const text = `${head}${parts.join("\n\n")}`;
  if (text.length <= DONE_REPORT_SECTION_MAX) return text;
  const cut = `\n\n[dipo: cut to keep the body under ${STORY_PR_MAX_BODY} characters]`;
  return `${text.slice(0, DONE_REPORT_SECTION_MAX - cut.length)}${cut}`;
}

const marker = (n: number): string =>
  `- … and ${n} more paths (cut to keep the body under ${STORY_PR_MAX_BODY} characters)`;

function scopeSection(paths: readonly string[], budget: number): string {
  const head = "## Declared scope\n\n";
  if (paths.length === 0) return `${head}- none`;
  const lines = paths.map((path) => `- \`${path}\``);
  if (head.length + lines.join("\n").length <= budget) return `${head}${lines.join("\n")}`;
  const reserve = marker(paths.length).length + 1;
  const kept: string[] = [];
  let used = head.length + reserve;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${head}${[...kept, marker(paths.length - kept.length)].join("\n")}`;
}

/** The body of a story PR. */
export function storyPrBody(story: PrBodyStory, status: PrBodyStatus): string {
  const outcome = `## Outcome\n\n${story.outcome.trim() === "" ? "none" : story.outcome.trim()}`;
  const criteria = [
    "## Acceptance criteria",
    "",
    ...story.criteria.map(
      (criterion) =>
        `- [${criterion.checked ? "x" : " "}] #${criterion.index} ${criterion.text.trim()}`,
    ),
  ].join("\n");
  const head = [outcome, criteria, testPlanSection(story.testPlan)].filter(
    (part): part is string => part !== null,
  );
  const tail = [
    ...[doneReportSection(story.doneReport)].filter((part): part is string => part !== null),
    statusSection(status),
    footer(story),
  ];
  const fixed = [...head, ...tail].join("\n\n").length;
  // Two blank lines join the scope section to its neighbours.
  const scope = scopeSection(story.scope, Math.max(0, STORY_PR_MAX_BODY - fixed - 2));
  return [...head, scope, ...tail].join("\n\n");
}

/** The hash a stored body is compared by. */
export function storyPrBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
