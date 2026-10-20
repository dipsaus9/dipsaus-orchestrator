// Feedback items (0014 section 7): built by code from the failing fact, with the evidence and a
// signature for send-once handling (M1). M0 builds verify items; DIPO-49 sends them. A verify item
// holds the failing step and command, the exit code, the last output lines and the `file:line`
// locations parsed from tsc, oxlint and bun test output. A CI item (DIPO-147; 0019 sections 7 and
// 8) holds a failed check's name, its job, the failing step names, the cut log tail and the
// locations parsed from it; a check with no log of its own says why.
//
// The reviewer's two correction turns (0019 section 4, DIPO-219) are built here too: a report
// missing or invalid against the review schema (`feedback/review-report.md`), and blocking
// findings whose evidence did not check out, each named with why (`feedback/review-evidence.md`).

import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import { formatCount } from "../context/truncate";
import { cutTailLines } from "./cut";
import reviewEvidenceTemplate from "./feedback/review-evidence.md" with { type: "text" };
import reviewReportTemplate from "./feedback/review-report.md" with { type: "text" };
import { FEEDBACK_TEMPLATES, renderTemplate } from "./templates";

/** The reviewer's correction turn for a report missing or invalid against its schema. */
export function reviewReportFeedback(why: string): string {
  return renderTemplate(reviewReportTemplate, { why });
}

/**
 * The reviewer's correction turn naming the blocking findings whose evidence failed, one line
 * each as `evidenceProblems` gives them (`finding 2 (security): ...`).
 */
export function reviewEvidenceFeedback(problems: readonly string[]): string {
  return renderTemplate(reviewEvidenceTemplate, {
    findings: problems.map((problem) => `- ${problem}`).join("\n"),
  });
}

/** The 0014 default: a log tail of at most 60 lines. */
export const FEEDBACK_LOG_LINES_DEFAULT = 60;

export interface SourceLocation {
  /** Repo-relative POSIX path when it lies in the work tree, else as printed. */
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export interface VerifyFailure {
  /** The verify step that failed, for example `lint`. */
  readonly step: string;
  /** The command as the run profile names it. */
  readonly command: string;
  readonly exitCode: number;
  /** The step's combined output. */
  readonly output: string;
}

export interface FeedbackItem {
  readonly kind: "verify" | "ci";
  /** sha256 over the failing fact, the same for the same failure (idea 17). */
  readonly signature: string;
  /** The rendered evidence. */
  readonly text: string;
}

export interface VerifyFeedbackItem extends FeedbackItem {
  readonly kind: "verify";
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** The last output lines, at most the log-line budget. */
  readonly tail: string;
  readonly locations: readonly SourceLocation[];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** At most this many locations are listed in an item; the rest are counted. */
export const FEEDBACK_LOCATIONS_MAX = 20;

/** Output without ANSI colour codes and with `\n` line endings. */
export function plainOutput(output: string): string {
  return output.replace(ANSI, "").replace(/\r\n?/g, "\n");
}

const PATTERNS: readonly RegExp[] = [
  // tsc: `src/a.ts(12,5): error TS2322: ...`
  /^\s*([^\s():][^():]*?)\((\d+),(\d+)\): (?:error|warning)/,
  // tsc --pretty: `src/a.ts:12:5 - error TS2322: ...`
  /^\s*(\S+?):(\d+):(\d+) - (?:error|warning)/,
  // oxlint (unix-style, when stdout is not a terminal): `src/a.ts:3:7: warning eslint(...)`
  /^\s*(\S+?):(\d+):(\d+): (?:error|warning)/,
  // oxlint (graphical): `   ,-[src/a.ts:3:7]` or `   ╭─[src/a.ts:3:7]`
  /^\s*(?:,-|╭─)\[(.+?):(\d+):(\d+)\]/,
  // bun test stack frames: `at <anonymous> (/repo/test/a.test.ts:3:17)` or `at /repo/a.ts:3:17`;
  // the path needs a file extension, so runtime frames such as `(native:7:39)` are skipped.
  /^\s*at (?:.*? \()?((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z0-9]+):(\d+):(\d+)\)?\s*$/,
];

function displayPath(file: string, root: string | undefined): string | undefined {
  if (root === undefined || !isAbsolute(file)) return file.split(sep).join("/");
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * The `file:line` locations in tsc, oxlint and bun test output, in order of first appearance,
 * without duplicates. With `root`, absolute paths become repo-relative and paths outside the work
 * tree (the runtime's own frames) are left out; `node_modules` frames are always left out.
 */
export function parseLocations(output: string, root?: string): SourceLocation[] {
  const seen = new Set<string>();
  const found: SourceLocation[] = [];
  for (const line of plainOutput(output).split("\n")) {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const file = displayPath(match[1] ?? "", root);
      if (file === undefined || file.split("/").includes("node_modules")) break;
      const location: SourceLocation = {
        file,
        line: Number(match[2]),
        column: Number(match[3]),
      };
      const key = `${location.file}:${location.line}:${location.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(location);
      }
      break;
    }
  }
  return found;
}

const formatLocation = (location: SourceLocation): string =>
  location.column === undefined
    ? `${location.file}:${location.line}`
    : `${location.file}:${location.line}:${location.column}`;

export interface VerifyFeedbackOptions {
  /** Absolute work tree, to make locations repo-relative. */
  readonly root?: string;
  /** Lines of output kept, the newest; default 60. */
  readonly logLines?: number;
  /** The item's character budget (`prompt.budgets.feedbackItem`); default 3,000. */
  readonly itemMax?: number;
}

function locationList(locations: readonly SourceLocation[]): string {
  if (locations.length === 0) return "- none found";
  const shown = locations.slice(0, FEEDBACK_LOCATIONS_MAX).map((l) => `- ${formatLocation(l)}`);
  const more = locations.length - shown.length;
  return more > 0 ? [...shown, `- and ${formatCount(more)} more`].join("\n") : shown.join("\n");
}

const tailMarker = (shown: number, total: number): string =>
  `[dipo: showing the last ${formatCount(shown)} of ${formatCount(total)} output lines.]`;

/** A verify feedback item from a failed step. */
export function verifyFeedback(
  failure: VerifyFailure,
  options: VerifyFeedbackOptions = {},
): VerifyFeedbackItem {
  const logLines = options.logLines ?? FEEDBACK_LOG_LINES_DEFAULT;
  const itemMax = options.itemMax ?? 3_000;
  const output = plainOutput(failure.output);
  const locations = parseLocations(output, options.root);
  const values = (tail: string) => ({
    step: failure.step,
    command: failure.command,
    exit_code: String(failure.exitCode),
    locations: locationList(locations),
    output: tail === "" ? "(no output)" : tail,
  });
  const frame = renderTemplate(FEEDBACK_TEMPLATES.verify, values(""));
  // The tail gets what the frame leaves of the item budget; a log keeps its newest lines.
  const room = Math.max(0, itemMax - (frame.length - "(no output)".length));
  const tail = cutTailLines(output, logLines, room, tailMarker).text;
  const signature = createHash("sha256")
    .update(
      JSON.stringify([
        "verify",
        failure.step,
        failure.command,
        failure.exitCode,
        locations.map(formatLocation),
      ]),
    )
    .digest("hex");
  return {
    kind: "verify",
    signature,
    text: renderTemplate(FEEDBACK_TEMPLATES.verify, values(tail)),
    step: failure.step,
    command: failure.command,
    exitCode: failure.exitCode,
    tail,
    locations,
  };
}

/** One failed check of a pushed head, as the code host reports it (0019 section 7). */
export interface CiFailure {
  /** The check's name. */
  readonly check: string;
  /** The check's link, or "" when it has none. */
  readonly link: string;
  /**
   * The failed-step log of the check's Actions job as `gh run view --log-failed` prints it
   * (`job<TAB>step<TAB>timestamp line`); null when no log was read.
   */
  readonly log: string | null;
  /** Why there is no log: the line the item shows in its place. Used only when `log` is null. */
  readonly noLog?: string;
}

export interface CiFeedbackItem extends FeedbackItem {
  readonly kind: "ci";
  readonly check: string;
  /** The job the log names; the check's name when there is no log. */
  readonly job: string;
  /** The names of the failing steps, in order of first appearance. */
  readonly steps: readonly string[];
  readonly link: string;
  /** The last log lines, at most the log-line budget; the `noLog` line when there is none. */
  readonly tail: string;
  readonly locations: readonly SourceLocation[];
}

/** The workspace prefix of a hosted runner's path (`/home/runner/work/REPO/REPO/`). */
const RUNNER_ROOT = /(?:\/home\/runner|\/Users\/runner)\/work\/[^/\s]+\/[^/\s]+\//g;
const LOG_TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;

/** The job, the failing step names and the log text of a `--log-failed` output. */
export function parseActionsLog(log: string): {
  job: string | null;
  steps: string[];
  text: string;
} {
  const steps: string[] = [];
  let job: string | null = null;
  const text: string[] = [];
  for (const line of plainOutput(log).replace(RUNNER_ROOT, "").split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      text.push(line);
      continue;
    }
    const [name = "", step = ""] = parts;
    job ??= name;
    if (step !== "" && step !== "UNKNOWN STEP" && !steps.includes(step)) steps.push(step);
    text.push(parts.slice(2).join("\t").replace(LOG_TIMESTAMP, ""));
  }
  return { job, steps, text: text.join("\n") };
}

/** A CI feedback item from a failed check (0019 sections 7 and 8). */
export function ciFeedback(
  failure: CiFailure,
  options: VerifyFeedbackOptions = {},
): CiFeedbackItem {
  const logLines = options.logLines ?? FEEDBACK_LOG_LINES_DEFAULT;
  const itemMax = options.itemMax ?? 3_000;
  const parsed = failure.log === null ? null : parseActionsLog(failure.log);
  const job = parsed?.job ?? failure.check;
  const steps = parsed?.steps ?? [];
  const output =
    parsed === null ? (failure.noLog ?? "no log was read for this check") : parsed.text;
  const locations = parsed === null ? [] : parseLocations(output, options.root);
  const values = (tail: string) => ({
    check: failure.check,
    job,
    steps: steps.length === 0 ? "none found" : steps.join(", "),
    link: failure.link === "" ? "none" : failure.link,
    locations: locationList(locations),
    output: tail === "" ? "(no output)" : tail,
  });
  const frame = renderTemplate(FEEDBACK_TEMPLATES.ci, values(""));
  const room = Math.max(0, itemMax - (frame.length - "(no output)".length));
  const tail = parsed === null ? output : cutTailLines(output, logLines, room, tailMarker).text;
  const signature = createHash("sha256")
    .update(JSON.stringify(["ci", failure.check, job, steps, locations.map(formatLocation)]))
    .digest("hex");
  return {
    kind: "ci",
    signature,
    text: renderTemplate(FEEDBACK_TEMPLATES.ci, values(tail)),
    check: failure.check,
    job,
    steps,
    link: failure.link,
    tail,
    locations,
  };
}
