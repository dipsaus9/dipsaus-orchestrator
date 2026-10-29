// The handoff block (0014 section 6): what a new session for a story with earlier work gets
// instead of a transcript. Code gathers it: the commits on the branch since the merge base, the
// criteria status of the last report, the last verify result, open feedback (0020 section 6), and
// the previous worker's notes, the only model-written part (at most 1,500 characters). The
// maintainer's resume note is not in the block: it is a held message of the one feedback path
// (0002), after the task message. The reviewer never gets one.
//
// The next session runs in the same kept box, whose files are the previous session's (0008). A
// story has no worktree (0010): the commits are the delivered parts on the branch, read from the
// branch ref, and the uncommitted changes are in the box, which the block says for a box run.

import { formatCount } from "../context/truncate";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { WorkerReportCriterion } from "../workers/types";
import { budgetLine, type BudgetFacts } from "./budget";
import { cutHead } from "./cut";
import { capNotes, latestWorkerNotes, WORKER_NOTES_MAX } from "./notes";
import { renderTemplate, TASK_TEMPLATES } from "./templates";

/** The 0014 default `handoff` budget. */
export const HANDOFF_BUDGET_DEFAULT = 6_000;

/** What the block says for the changes of a box run, which stay in the kept box. */
export const BOX_CHANGES = "in your box (dipo lists only the delivered parts above)";

/** An open feedback item as the handoff lists it: the first line of its rendered text shows. */
export interface HandoffFeedback {
  readonly text: string;
}

/** The last verify run: passed, or the step that failed with its exit code. */
export type LastVerify =
  | { readonly passed: true }
  | { readonly passed: false; readonly step: string; readonly exitCode: number };

export interface HandoffFacts {
  /** `git log --oneline <base>..<branch>`, oldest last as git prints it. */
  readonly commits: string;
  /** Criteria status from the last worker report; null when there is none. */
  readonly criteria: readonly WorkerReportCriterion[] | null;
  readonly verify: LastVerify | null;
  readonly feedback: readonly HandoffFeedback[];
  /** The previous worker's notes; null when there are none. */
  readonly notes: string | null;
  /** A box run: its undelivered changes are in the kept box (`BOX_CHANGES`). */
  readonly box?: boolean;
  /** The run's caps and usage: the block ends with the budget line (DIPO-256). */
  readonly budget?: BudgetFacts;
}

export interface GatherHandoffOptions {
  readonly git: OfficeGit;
  /** The story branch. */
  readonly branch: string;
  /** The merge base or base ref the branch started from. */
  readonly base: string;
  readonly office: OfficeHandle;
  readonly lastReport: { readonly criteria: readonly WorkerReportCriterion[] } | null;
  readonly lastVerify: LastVerify | null;
  readonly openFeedback: readonly HandoffFeedback[];
  /** A box run: the block says the changes are in the box. */
  readonly box?: boolean;
  /** The run's caps and usage: the block ends with the budget line (DIPO-256). */
  readonly budget?: BudgetFacts;
}

/**
 * Reads the handoff facts of a story: its branch's commits through the office queue, notes from
 * the database.
 */
export async function gatherHandoff(options: GatherHandoffOptions): Promise<HandoffFacts> {
  const { git } = options;
  const box = options.box === true;
  const commits = await git.run((session) =>
    session.ok(session.repository, [
      "log",
      "--oneline",
      "--no-decorate",
      `${options.base}..refs/heads/${options.branch}`,
    ]),
  );
  const notes = latestWorkerNotes(options.office, options.branch);
  return {
    commits: commits.trimEnd(),
    criteria: options.lastReport?.criteria ?? null,
    verify: options.lastVerify,
    feedback: options.openFeedback,
    notes: notes?.text ?? null,
    ...(box ? { box: true } : {}),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  };
}

const NONE = "none";

const listMarker = (label: string, hint: string) => (shown: number, total: number) =>
  `[dipo: ${label} cut, showing ${formatCount(shown)} of ${formatCount(total)} characters; ${hint}]`;

/** A box run's verify is CI on the story PR (0021 amendment of 2026-10-22); dipo runs none. */
export const BOX_VERIFY =
  "none by dipo in a box run: CI on the story PR checks the delivered parts, and red CI is listed under open feedback";

function verifyLine(verify: LastVerify | null, box: boolean): string {
  if (verify === null) return box ? BOX_VERIFY : "not run yet";
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
function feedbackLines(items: readonly HandoffFeedback[]): string {
  return items.map((item) => `- ${item.text.split("\n")[0] ?? ""}`).join("\n");
}

/** The most characters of a maintainer's note a worker gets (`capNote`). */
export const HANDOFF_NOTE_MAX = 1_000;

const noteMarker = (shown: number, total: number): string =>
  `[dipo: note cut, showing ${formatCount(shown)} of ${formatCount(total)} characters.]`;

/**
 * The maintainer's note with LF line endings, trimmed and capped at `HANDOFF_NOTE_MAX` characters
 * with a marker; empty without a note. Every place a note reaches a worker uses it (DIPO-155).
 */
export function capNote(note: string | undefined): string {
  const text = (note ?? "").replace(/\r\n?/g, "\n").trim();
  if (text.length <= HANDOFF_NOTE_MAX) return text;
  let shown = text.slice(0, HANDOFF_NOTE_MAX - noteMarker(text.length, text.length).length - 1);
  // Never leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  return `${shown.trimEnd()}\n${noteMarker(shown.trimEnd().length, text.length)}`;
}

/** Room the handoff keeps for its headings, criteria status and verify line. */
const HANDOFF_FRAME = 600;
/** The smallest share a list gets, however small the budget. */
const HANDOFF_LIST_MIN = 200;

/**
 * The `handoff` section. The notes are capped at 1,500 characters; the two lists (commits and
 * open feedback) share what is left of `budget` after them and the frame, each cut at its head
 * with a marker that says how to see the rest, so the block stays within `budget` and its closing
 * tag is never cut. A story has no worktree (0010), so its undelivered changes are only named as
 * in the box.
 */
export function renderHandoff(facts: HandoffFacts, budget = HANDOFF_BUDGET_DEFAULT): string {
  const listMax = Math.max(
    HANDOFF_LIST_MIN,
    Math.floor((budget - WORKER_NOTES_MAX - HANDOFF_FRAME) / 2),
  );
  const list = (text: string, label: string, hint: string) =>
    text === "" ? NONE : cutHead(text, listMax, listMarker(label, hint)).text;
  const box = facts.box === true;
  return renderTemplate(TASK_TEMPLATES.handoff, {
    commits: list(facts.commits, "commit list", "run git log for the rest."),
    undelivered: box ? BOX_CHANGES : NONE,
    criteria: criteriaLines(facts.criteria),
    verify: verifyLine(facts.verify, box),
    feedback: list(feedbackLines(facts.feedback), "feedback list", "the rest is left out."),
    budget: facts.budget === undefined ? "" : budgetLine(facts.budget),
    notes: facts.notes === null || facts.notes.trim() === "" ? NONE : capNotes(facts.notes),
  });
}
