// The handoff block (0014 section 6): what a new session for a story with earlier work gets
// instead of a transcript. Code gathers it: the commits on the branch since the merge base, the
// uncommitted work (`git diff --stat HEAD` and the untracked files), the criteria status of the
// last report, the last verify result, open feedback, and the previous worker's notes, the only
// model-written part (at most 1,500 characters). The reviewer never gets one.

import { formatCount } from "../context/truncate";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import type { WorkerReportCriterion } from "../workers/types";
import { cutHead } from "./cut";
import type { FeedbackItem } from "./feedback";
import { capNotes, latestWorkerNotes, WORKER_NOTES_MAX } from "./notes";
import { renderTemplate, TASK_TEMPLATES } from "./templates";

/** The 0014 default `handoff` budget. */
export const HANDOFF_BUDGET_DEFAULT = 6_000;

/** The last verify run: passed, or the step that failed with its exit code. */
export type LastVerify =
  | { readonly passed: true }
  | { readonly passed: false; readonly step: string; readonly exitCode: number };

export interface HandoffFacts {
  /** `git log --oneline <base>..HEAD`, oldest last as git prints it. */
  readonly commits: string;
  /** `git diff --stat HEAD`. */
  readonly diffstat: string;
  /** Untracked, not ignored, repo-relative paths, sorted. */
  readonly untracked: readonly string[];
  /** Criteria status from the last worker report; null when there is none. */
  readonly criteria: readonly WorkerReportCriterion[] | null;
  readonly verify: LastVerify | null;
  readonly feedback: readonly FeedbackItem[];
  /** The previous worker's notes; null when there are none. */
  readonly notes: string | null;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

export interface GatherHandoffOptions {
  readonly git: OfficeGit;
  readonly location: WorktreeLocation;
  /** The merge base or base ref the branch started from. */
  readonly base: string;
  readonly office: OfficeHandle;
  readonly lastReport: { readonly criteria: readonly WorkerReportCriterion[] } | null;
  readonly lastVerify: LastVerify | null;
  readonly openFeedback: readonly FeedbackItem[];
}

/** Reads the handoff facts of a worktree: git through the office queue, notes from the database. */
export async function gatherHandoff(options: GatherHandoffOptions): Promise<HandoffFacts> {
  const { git, location } = options;
  const run = (args: readonly string[]) => git.run((session) => session.ok(location, args));
  const commits = await run(["log", "--oneline", "--no-decorate", `${options.base}..HEAD`]);
  const diffstat = await run(["diff", "--stat=120", "HEAD"]);
  const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .toSorted();
  const notes = latestWorkerNotes(options.office, location.workTree);
  return {
    commits: commits.trimEnd(),
    diffstat: diffstat.trimEnd(),
    untracked,
    criteria: options.lastReport?.criteria ?? null,
    verify: options.lastVerify,
    feedback: options.openFeedback,
    notes: notes?.text ?? null,
  };
}

const NONE = "none";

const listMarker = (label: string, hint: string) => (shown: number, total: number) =>
  `[dipo: ${label} cut, showing ${formatCount(shown)} of ${formatCount(total)} characters; ${hint}]`;

function verifyLine(verify: LastVerify | null): string {
  if (verify === null) return "not run yet";
  if (verify.passed) return "passed";
  return `failed at the ${verify.step} step with exit code ${verify.exitCode}`;
}

function criteriaLines(criteria: readonly WorkerReportCriterion[] | null): string {
  if (criteria === null || criteria.length === 0) return NONE;
  return criteria
    .toSorted((a, b) => a.n - b.n)
    .map((criterion) => `#${criterion.n} ${criterion.met ? "met" : "not met"}`)
    .join("\n");
}

/** The first line of each open feedback item. */
function feedbackLines(items: readonly FeedbackItem[]): string {
  if (items.length === 0) return "";
  return items.map((item) => `- ${item.text.split("\n")[0] ?? ""}`).join("\n");
}

/** Room the handoff keeps for its headings, criteria status and verify line. */
const HANDOFF_FRAME = 600;
/** The smallest share a list gets, however small the budget. */
const HANDOFF_LIST_MIN = 200;

/**
 * The `handoff` section. The notes are capped at 1,500 characters; the four lists (commits,
 * changes, untracked files, open feedback) share what is left of `budget` after the notes and the
 * frame, each cut at its head with a marker that says how to see the rest, so the block stays
 * within `budget` and its closing tag is never cut.
 */
export function renderHandoff(facts: HandoffFacts, budget = HANDOFF_BUDGET_DEFAULT): string {
  const listMax = Math.max(
    HANDOFF_LIST_MIN,
    Math.floor((budget - WORKER_NOTES_MAX - HANDOFF_FRAME) / 4),
  );
  const list = (text: string, label: string, hint: string) =>
    text === "" ? NONE : cutHead(text, listMax, listMarker(label, hint)).text;
  return renderTemplate(TASK_TEMPLATES.handoff, {
    commits: list(facts.commits, "commit list", "run git log for the rest."),
    diffstat: list(facts.diffstat, "change list", "run git diff --stat for the rest."),
    untracked: list(facts.untracked.join("\n"), "untracked list", "run git status for the rest."),
    criteria: criteriaLines(facts.criteria),
    verify: verifyLine(facts.verify),
    feedback: list(feedbackLines(facts.feedback), "feedback list", "the rest is left out."),
    notes: facts.notes === null || facts.notes.trim() === "" ? NONE : capNotes(facts.notes),
  });
}
