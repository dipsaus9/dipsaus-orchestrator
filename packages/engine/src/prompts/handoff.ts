// The handoff block (0014 section 6): what a new session for a story with earlier work gets
// instead of a transcript. Code gathers it: the commits on the branch since the merge base, the
// uncommitted work (`git diff --stat HEAD` and the untracked files), the criteria status of the
// last report, the last verify result, open feedback with the maintainer's resume note (0020
// sections 3 and 6), and the previous worker's notes, the only model-written part (at most 1,500
// characters). The reviewer never gets one.
//
// A box run (0021 sections 6 and 8): the next session runs in the same kept box, whose files are
// the previous session's, while dipo's Mac worktree only follows the delivered parts with its
// branch (its files stay at the start commit, DIPO-302). So the commits are the delivered parts,
// and the uncommitted changes and untracked files are not read from the Mac worktree: the block
// says they are in the box.

import { formatCount } from "../context/truncate";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
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
  /** `git log --oneline <base>..HEAD`, oldest last as git prints it. */
  readonly commits: string;
  /** `git diff --stat HEAD`. */
  readonly diffstat: string;
  /** Untracked, not ignored, repo-relative paths, sorted. */
  readonly untracked: readonly string[];
  /** Criteria status from the last worker report; null when there is none. */
  readonly criteria: readonly WorkerReportCriterion[] | null;
  readonly verify: LastVerify | null;
  readonly feedback: readonly HandoffFeedback[];
  /** The maintainer's resume note (0020 section 3), listed after the open feedback. */
  readonly note?: string;
  /** The previous worker's notes; null when there are none. */
  readonly notes: string | null;
  /** A box run: the changes are in the kept box, not in the Mac worktree (`BOX_CHANGES`). */
  readonly box?: boolean;
  /** The run's caps and usage: the block ends with the budget line (DIPO-256). */
  readonly budget?: BudgetFacts;
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
  readonly openFeedback: readonly HandoffFeedback[];
  /** The maintainer's resume note, when the resume carries one. */
  readonly note?: string;
  /** A box run: the Mac worktree's diff and untracked files are not read. */
  readonly box?: boolean;
  /** The run's caps and usage: the block ends with the budget line (DIPO-256). */
  readonly budget?: BudgetFacts;
}

/** Reads the handoff facts of a worktree: git through the office queue, notes from the database. */
export async function gatherHandoff(options: GatherHandoffOptions): Promise<HandoffFacts> {
  const { git, location } = options;
  const box = options.box === true;
  const run = (args: readonly string[]) => git.run((session) => session.ok(location, args));
  const commits = await run(["log", "--oneline", "--no-decorate", `${options.base}..HEAD`]);
  const diffstat = box ? "" : await run(["diff", "--stat=120", "HEAD"]);
  const status = box ? "" : await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .toSorted();
  const notes = latestWorkerNotes(options.office, location.workTree);
  const note = options.note?.trim() ?? "";
  return {
    commits: commits.trimEnd(),
    diffstat: diffstat.trimEnd(),
    untracked,
    criteria: options.lastReport?.criteria ?? null,
    verify: options.lastVerify,
    feedback: options.openFeedback,
    ...(note === "" ? {} : { note }),
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

/** The most characters of the maintainer's resume note the handoff carries. */
export const HANDOFF_NOTE_MAX = 1_000;

const noteMarker = (shown: number, total: number): string =>
  `[dipo: note cut, showing ${formatCount(shown)} of ${formatCount(total)} characters.]`;

/**
 * The maintainer's resume note as one block after the open feedback (0020 section 3): capped at
 * `HANDOFF_NOTE_MAX` characters with a marker, behind a fixed lead, and every further line
 * indented, so no line of it ever starts a line of its own in the message. Null without a note.
 */
export function noteBlock(note: string | undefined): string | null {
  const text = (note ?? "").replace(/\r\n?/g, "\n").trim();
  if (text === "") return null;
  let shown = text;
  if (text.length > HANDOFF_NOTE_MAX) {
    shown = text.slice(0, HANDOFF_NOTE_MAX - noteMarker(text.length, text.length).length - 1);
    // Never leave half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
    shown = `${shown.trimEnd()}\n${noteMarker(shown.trimEnd().length, text.length)}`;
  }
  const [first, ...rest] = shown.split("\n");
  return [
    `- Note from the maintainer: ${first ?? ""}`,
    ...rest.map((line) => (line.trim() === "" ? "" : `  ${line}`)),
  ].join("\n");
}

/** Room the handoff keeps for its headings, criteria status and verify line. */
const HANDOFF_FRAME = 600;
/** The smallest share a list gets, however small the budget. */
const HANDOFF_LIST_MIN = 200;

/**
 * The `handoff` section. The notes are capped at 1,500 characters and the maintainer's resume note
 * at 1,000; the four lists (commits, changes, untracked files, open feedback) share what is left
 * of `budget` after them and the frame, each cut at its head with a marker that says how to see
 * the rest, so the block stays within `budget` and its closing tag is never cut. The resume note
 * follows the open feedback list, outside its cut, so it always shows.
 */
export function renderHandoff(facts: HandoffFacts, budget = HANDOFF_BUDGET_DEFAULT): string {
  const note = noteBlock(facts.note);
  const listMax = Math.max(
    HANDOFF_LIST_MIN,
    Math.floor((budget - WORKER_NOTES_MAX - (note?.length ?? 0) - HANDOFF_FRAME) / 4),
  );
  const list = (text: string, label: string, hint: string) =>
    text === "" ? NONE : cutHead(text, listMax, listMarker(label, hint)).text;
  const box = facts.box === true;
  return renderTemplate(TASK_TEMPLATES.handoff, {
    commits: list(facts.commits, "commit list", "run git log for the rest."),
    diffstat: box
      ? BOX_CHANGES
      : list(facts.diffstat, "change list", "run git diff --stat for the rest."),
    untracked: box
      ? BOX_CHANGES
      : list(facts.untracked.join("\n"), "untracked list", "run git status for the rest."),
    criteria: criteriaLines(facts.criteria),
    verify: verifyLine(facts.verify, box),
    feedback:
      note === null
        ? list(feedbackLines(facts.feedback), "feedback list", "the rest is left out.")
        : [
            ...(facts.feedback.length === 0
              ? []
              : [list(feedbackLines(facts.feedback), "feedback list", "the rest is left out.")]),
            note,
          ].join("\n"),
    budget: facts.budget === undefined ? "" : budgetLine(facts.budget),
    notes: facts.notes === null || facts.notes.trim() === "" ? NONE : capNotes(facts.notes),
  });
}
