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
//
// A fix round's items (DIPO-148; 0019 section 8): a blocked verdict's unmet criteria and blocking
// findings, each with the evidence and a signature over the fields that identify it, never over
// the reviewer's free text; a maintainer reject's note verbatim, keyed on its gate id; and the one
// user message that carries every item for a pushed head, repeats marked, advisories as optional.

import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import { formatCount } from "../context/truncate";
import { budgetLine, withBudgetLine, type BudgetFacts } from "./budget";
import { cutHead, cutTailLines } from "./cut";
import decisionNoteTemplate from "./feedback/decision-note.md" with { type: "text" };
import fixRoundOptionalTemplate from "./feedback/fix-round-optional.md" with { type: "text" };
import fixRoundTemplate from "./feedback/fix-round.md" with { type: "text" };
import rejectTemplate from "./feedback/reject.md" with { type: "text" };
import reviewCriterionTemplate from "./feedback/review-criterion.md" with { type: "text" };
import reviewEvidenceTemplate from "./feedback/review-evidence.md" with { type: "text" };
import reviewFindingTemplate from "./feedback/review-finding.md" with { type: "text" };
import reviewReportTemplate from "./feedback/review-report.md" with { type: "text" };
import testPlanTemplate from "./feedback/test-plan.md" with { type: "text" };
import { FEEDBACK_TEMPLATES, neutraliseTags, rendered, renderTemplate } from "./templates";

/** The longest test-plan check a test-plan feedback line quotes, in characters. */
export const TEST_PLAN_CHECK_MAX = 300;

/**
 * A done report refused for its test plan (DIPO-254): one line per automated entry it does not
 * show as done, with its number, what the report said and the entry's check.
 */
export function testPlanFeedback(
  gaps: readonly {
    readonly n: number;
    readonly check: string;
    readonly reported: "not-done" | "manual" | "missing";
  }[],
): string {
  const said = {
    "not-done": "reported not done",
    manual: "reported manual",
    missing: "not reported",
  };
  return renderTemplate(testPlanTemplate, {
    entries: gaps
      .map((gap) => {
        const check =
          gap.check.length > TEST_PLAN_CHECK_MAX
            ? `${gap.check.slice(0, TEST_PLAN_CHECK_MAX)}…`
            : gap.check;
        return `- #${gap.n} (${said[gap.reported]}): ${check}`;
      })
      .join("\n"),
  });
}

/**
 * Decision notes dipo cannot place (DIPO-186): one line per note naming its file and section and
 * whether the file or the section is missing.
 */
export function decisionNoteFeedback(
  misses: readonly {
    readonly file: string;
    readonly section: string;
    readonly miss: "file" | "section";
  }[],
): string {
  return renderTemplate(decisionNoteTemplate, {
    notes: misses
      .map(
        (miss) =>
          `- ${miss.file}, section "${miss.section}": ${miss.miss === "file" ? "the file does not exist" : "the file has no section with that heading"}`,
      )
      .join("\n"),
  });
}

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
  /** The exit code, or why there is none (a deadline, a signal). */
  readonly exitCode: number | string;
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
  readonly exitCode: number | string;
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
  /** The run's caps and usage: the item ends with the budget line (DIPO-256). */
  readonly budget?: BudgetFacts;
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
  const itemMax = (options.itemMax ?? 3_000) - budgetRoom(options.budget);
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
    text: withBudgetLine(renderTemplate(FEEDBACK_TEMPLATES.verify, values(tail)), options.budget),
    step: failure.step,
    command: failure.command,
    exitCode: failure.exitCode,
    tail,
    locations,
  };
}

/** What the budget line takes of an item's character budget: the line and its newline. */
function budgetRoom(budget: BudgetFacts | undefined): number {
  return budget === undefined ? 0 : budgetLine(budget).length + 1;
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
  const itemMax = (options.itemMax ?? 3_000) - budgetRoom(options.budget);
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
    text: withBudgetLine(renderTemplate(FEEDBACK_TEMPLATES.ci, values(tail)), options.budget),
    check: failure.check,
    job,
    steps,
    link: failure.link,
    tail,
    locations,
  };
}

// ---- review, reject and fix-round items (0019 section 8, DIPO-148) -------------------------------

/** Where a fix round's feedback item came from (0019 section 8). */
export type FeedbackSource = "verify" | "ci" | "review" | "conflict" | "reject";

/** One item a fix round carries: its source, its signature and its rendered evidence. */
export interface FixItem {
  readonly source: FeedbackSource;
  /** sha256 over the fields that identify the failure; for a reject, its gate id. */
  readonly signature: string;
  readonly text: string;
}

/** The most characters of one stored item (0014's per-item budget, `feedback_items.text`). */
export const FEEDBACK_ITEM_MAX = 3_000;

/** The most characters of one fix round's message (0014's per-message budget). */
export const FEEDBACK_MESSAGE_MAX = 8_000;

const itemCutMarker = (shown: number, total: number): string =>
  `[dipo: cut, showing ${formatCount(shown)} of ${formatCount(total)} characters.]`;

/** `text` within `max` characters, cut at its end with a marker; whole lines where it can. */
export function capFeedbackText(text: string, max: number = FEEDBACK_ITEM_MAX): string {
  if (text.length <= max) return text;
  const cut = cutHead(text, max, itemCutMarker).text;
  if (!cut.startsWith("[dipo: cut")) return cut;
  // The first line alone is longer than the budget: cut inside it.
  const room = Math.max(0, max - itemCutMarker(text.length, text.length).length - 1);
  return `${text.slice(0, room)}\n${itemCutMarker(room, text.length)}`;
}

/** Every run of whitespace as one space, trimmed: a quote's identity for its signature. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const sha = (fields: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(fields)).digest("hex");

/** A review criterion result as the verdict stores it. */
export interface ReviewCriterionFact {
  readonly n: number;
  readonly status: string;
  readonly evidence: string;
}

/** A review finding as the verdict stores it. */
export interface ReviewFindingFact {
  readonly severity: "blocking" | "advisory";
  readonly kind: string;
  readonly testEntry?: number | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly quote?: string | undefined;
  readonly text: string;
}

/**
 * The signature of a review item (0019 section 8): an unmet criterion by its number and status; a
 * finding by its kind, file and the quote with whitespace collapsed, or by its kind and test-plan
 * entry. The reviewer's free text never counts, so a reworded finding on the same line is a repeat.
 */
export function reviewCriterionSignature(criterion: Pick<ReviewCriterionFact, "n" | "status">) {
  return sha(["review", "criterion", criterion.n, criterion.status]);
}

/** See `reviewCriterionSignature`. */
export function reviewFindingSignature(finding: ReviewFindingFact): string {
  if (finding.file === undefined && finding.testEntry !== undefined) {
    return sha(["review", finding.kind, "test-entry", finding.testEntry]);
  }
  return sha(["review", finding.kind, finding.file ?? "", collapseWhitespace(finding.quote ?? "")]);
}

/**
 * The items of a blocked verdict (0019 section 8): one per unmet criterion, with its text and the
 * reviewer's evidence, and one per blocking finding, with its kind, `file:line`, the quoted line or
 * the test-plan entry, and its text. `criterionText` gives a criterion's text by its number.
 */
export function reviewFeedbackItems(
  verdict: {
    readonly criteria: readonly ReviewCriterionFact[];
    readonly findings: readonly ReviewFindingFact[];
  },
  criterionText: (n: number) => string | undefined = () => undefined,
  itemMax: number = FEEDBACK_ITEM_MAX,
): FixItem[] {
  const max = Math.min(itemMax, FEEDBACK_ITEM_MAX);
  const criteria = verdict.criteria
    .filter((entry) => entry.status === "unmet")
    .map((entry): FixItem => ({
      source: "review",
      signature: reviewCriterionSignature(entry),
      text: capFeedbackText(
        renderTemplate(reviewCriterionTemplate, {
          n: String(entry.n),
          criterion: criterionText(entry.n)?.trim() || "(its text was not read)",
          evidence: entry.evidence.trim() || "none given",
        }),
        max,
      ),
    }));
  const findings = verdict.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding): FixItem => ({
      source: "review",
      signature: reviewFindingSignature(finding),
      text: capFeedbackText(
        renderTemplate(reviewFindingTemplate, {
          kind: finding.kind,
          where: findingWhere(finding),
          quote:
            finding.quote === undefined || finding.quote.trim() === ""
              ? ""
              : `Quoted line: ${finding.quote.trim()}`,
          text: finding.text.trim(),
        }),
        max,
      ),
    }));
  return [...criteria, ...findings];
}

function findingWhere(finding: ReviewFindingFact): string {
  if (finding.file !== undefined) {
    return ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
  }
  return finding.testEntry === undefined ? "" : ` (test-plan entry #${finding.testEntry})`;
}

/** The advisory findings of a verdict, one line each, for a fix round's optional list. */
export function advisoryLines(findings: readonly ReviewFindingFact[]): string[] {
  return findings
    .filter((finding) => finding.severity === "advisory")
    .map((finding) => `- ${finding.kind}${findingWhere(finding)}: ${finding.text.trim()}`);
}

/** The signature of a maintainer reject: none of its own, keyed on the gate id (section 8). */
export function rejectSignature(gateId: string): string {
  return `gate:${gateId}`;
}

/**
 * A maintainer reject item (0019 sections 8 and 11), from what `gate.reject` records (DIPO-151):
 * the note verbatim, keyed on the gate id, so it is sent once.
 */
export function rejectFeedbackItem(reject: { readonly gateId: string; readonly note: string }) {
  return {
    source: "reject",
    signature: rejectSignature(reject.gateId),
    text: capFeedbackText(renderTemplate(rejectTemplate, { note: reject.note })),
  } satisfies FixItem;
}

/** One item of a fix round's message, as stored. */
export interface FixRoundItem {
  readonly source: FeedbackSource;
  readonly text: string;
  /** The same signature was sent for an earlier head. */
  readonly repeat: boolean;
}

/**
 * The one user message of a fix round (0019 section 8): every item for the pushed head `head`, a
 * repeat marked "still failing after your last change", and the verdict's advisory findings listed
 * as optional. Cut to `FEEDBACK_MESSAGE_MAX` at the end.
 */
export function fixRoundMessage(input: {
  readonly head: string;
  readonly items: readonly FixRoundItem[];
  readonly advisories: readonly string[];
}): string {
  const items = input.items
    .map((item, index) => {
      const repeat = item.repeat ? ", still failing after your last change" : "";
      return `Item ${index + 1} (${item.source}${repeat}):\n${neutraliseTags(item.text)}`;
    })
    .join("\n\n");
  const optional =
    input.advisories.length === 0
      ? ""
      : renderTemplate(fixRoundOptionalTemplate, { findings: input.advisories.join("\n") });
  const text = renderTemplate(fixRoundTemplate, {
    head: input.head.slice(0, 12),
    items: rendered(items),
    optional: rendered(optional),
  });
  return text.length <= FEEDBACK_MESSAGE_MAX ? text : capFeedbackText(text, FEEDBACK_MESSAGE_MAX);
}
