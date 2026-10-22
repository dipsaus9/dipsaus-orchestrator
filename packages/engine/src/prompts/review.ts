// The `review` task message, L4 (0019 section 4, 0014 sections 2 and 4): what a reviewer receives.
// The changed paths with line counts, the diff from the merge base without the story's own task
// file (within the 0014 diff budget), the gate script changes the run recorded, the story facts
// (story, outcome, criteria, scope, the test plan with its entry numbers, resolved unknowns) and,
// on a re-review, the previous round's findings. Of the worker's report only the test-plan
// statuses with their evidence and the deviations of its last done report (0021 section 15,
// DIPO-254), as the worker's own account; never its summary, notes, handoff, reasoning or
// transcript (0002): the input has no field for them. Pure and deterministic.

import { formatCount } from "../context/truncate";
import type { ReviewFinding, WorkerDeviation, WorkerTestPlanEntry } from "../workers/types";
import { assembleContract, CONTRACT_MAX_DEFAULT } from "./contract";
import type { PromptStory } from "./story";
import { renderTemplate, TASK_TEMPLATES } from "./templates";
import workerReportTemplate from "./task/review-worker-report.md" with { type: "text" };

/** The `review` task message sections in message order. */
export const REVIEW_SECTION_ORDER = [
  "changes",
  "diff",
  "gate_changes",
  "story",
  "outcome",
  "criteria",
  "scope",
  "test_plan",
  "worker_report",
  "answers",
  "previous_findings",
] as const;
export type ReviewSectionName = (typeof REVIEW_SECTION_ORDER)[number];

export interface ReviewSection {
  readonly name: ReviewSectionName;
  readonly text: string;
}

/** One changed path as `git diff --numstat` gives it; null counts for a binary file. */
export interface ReviewChangedPath {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

export interface ReviewTaskInput {
  readonly story: PromptStory;
  /** The merge base the diff starts from; the cut marker names it and points to the `<commit>` copy. */
  readonly base: string;
  /** Every changed path; the story's task file is left out here. */
  readonly changes: readonly ReviewChangedPath[];
  /** `git diff <base>...HEAD`, unified; the story's task file is left out here. */
  readonly diff: string;
  /** The gate changes the run recorded (`runs.gate_changes`, 0013 section 5); empty for none. */
  readonly gateChanges: readonly string[];
  /** The previous round's findings, on a re-review. */
  readonly previousFindings?: readonly ReviewFinding[];
  /**
   * The test-plan statuses and deviations of the worker's last done report (DIPO-254), when the
   * run stored one.
   */
  readonly workerReport?: {
    readonly testPlan: readonly WorkerTestPlanEntry[];
    readonly deviations: readonly WorkerDeviation[];
  };
  /** The `diff` budget of the project's size class, in characters (0014 section 4). */
  readonly diffBudget: number;
  /** `prompt.contractMax`; default 12,000. */
  readonly contractMax?: number;
}

export interface ReviewTaskMessage {
  /** The message, sections separated by a blank line, ending in one newline. */
  readonly text: string;
  readonly sections: readonly ReviewSection[];
  /** True when the diff was over its budget and only its largest hunks are shown. */
  readonly diffCut: boolean;
}

/** One file of a unified diff: its header lines and its hunks, each ending in a newline. */
interface DiffFile {
  readonly path: string;
  readonly header: string;
  readonly hunks: readonly string[];
}

const DIFF_HEADER = "diff --git ";

/** The path a `diff --git` section is about: `b/<path>`, or what `+++` or a rename names. */
function diffPath(lines: readonly string[]): string {
  const rest = (lines[0] ?? "").slice(DIFF_HEADER.length);
  // `a/<path> b/<path>` with the same path on both sides, spaces in it included.
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const path = rest.slice(2, 2 + half);
    if (rest === `a/${path} b/${path}`) return path;
  }
  for (const line of lines) {
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length);
    if (line.startsWith("rename to ")) return line.slice("rename to ".length);
  }
  return /^a\/.* b\/(.*)$/.exec(rest)?.[1] ?? rest;
}

/** Pure: a unified diff split into files and hunks; text before the first file is dropped. */
function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let header: string[] = [];
  let hunks: string[][] = [];
  const flush = () => {
    if (header.length === 0) return;
    files.push({
      path: diffPath(header),
      header: header.map((line) => `${line}\n`).join(""),
      hunks: hunks.map((hunk) => hunk.map((line) => `${line}\n`).join("")),
    });
  };
  const lines = diff.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  for (const line of diff === "" ? [] : lines) {
    if (line.startsWith(DIFF_HEADER)) {
      flush();
      header = [line];
      hunks = [];
    } else if (header.length === 0) {
      continue;
    } else if (line.startsWith("@@")) {
      hunks.push([line]);
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1]?.push(line);
    } else {
      header.push(line);
    }
  }
  flush();
  return files;
}

const joinFiles = (files: readonly DiffFile[]): string =>
  files.map((file) => `${file.header}${file.hunks.join("")}`).join("");

/**
 * The diff within `budget` (0014 section 4): whole when it fits; otherwise the largest hunks that
 * fit, each under its file header and in diff order, then a marker that says how to read the rest.
 * The per-file stat is the `changes` section.
 */
function budgetedDiff(
  files: readonly DiffFile[],
  budget: number,
  base: string,
): { text: string; cut: boolean } {
  const whole = joinFiles(files).replace(/\n$/, "");
  if (whole.length <= budget) return { text: whole === "" ? "No changes." : whole, cut: false };
  const hunks = files.flatMap((file, at) => file.hunks.map((text, index) => ({ at, index, text })));
  const marker = (shown: number) =>
    `[dipo: the diff is ${formatCount(whole.length)} characters, over its ${formatCount(budget)} character limit, so only the ${formatCount(shown)} largest of its ${formatCount(hunks.length)} hunks are shown. <changes> lists every changed path; read a changed file whole, as the commit has it, in the folder <commit> names. The diff starts at ${base}.]`;
  const room = budget - marker(hunks.length).length - 1;
  const chosen = new Set<string>();
  const opened = new Set<number>();
  let used = 0;
  // Largest first; equal sizes keep diff order. A hunk that does not fit is skipped, so a smaller
  // one after it may still be shown.
  const bySize = hunks
    .map((hunk, order) => ({ ...hunk, order }))
    .toSorted((a, b) => b.text.length - a.text.length || a.order - b.order);
  for (const hunk of bySize) {
    const header = opened.has(hunk.at) ? 0 : (files[hunk.at]?.header.length ?? 0);
    if (used + header + hunk.text.length > room) continue;
    used += header + hunk.text.length;
    opened.add(hunk.at);
    chosen.add(`${hunk.at}:${hunk.index}`);
  }
  const shown = files.flatMap((file, at) => {
    const kept = file.hunks.filter((_, index) => chosen.has(`${at}:${index}`));
    return kept.length === 0 ? [] : [{ ...file, hunks: kept }];
  });
  return { text: `${joinFiles(shown)}${marker(chosen.size)}`, cut: true };
}

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");

function changeLine(change: ReviewChangedPath): string {
  if (change.added === null || change.removed === null) return `${change.path} (binary)`;
  return `${change.path} (+${formatCount(change.added)} -${formatCount(change.removed)})`;
}

/** The test plan with every entry numbered from 1 in field block order, as `testEntry` counts. */
function testPlanSection(story: PromptStory): ReviewSection | undefined {
  const plan = story.testPlan;
  if (story.type === "spike" || plan === undefined) return undefined;
  if (plan.not_applicable !== undefined) {
    return {
      name: "test_plan",
      text: renderTemplate(TASK_TEMPLATES.testPlanNotApplicable, { reason: plan.not_applicable }),
    };
  }
  const entries = (plan.entries ?? []).map((entry, index) => {
    const line = `#${index + 1} ${entry.kind}: ${entry.check.trim()}`;
    return entry.expect === undefined ? line : `${line} Expected: ${entry.expect.trim()}`;
  });
  return {
    name: "test_plan",
    text: renderTemplate(TASK_TEMPLATES.reviewTestPlan, {
      entries: entries.length === 0 ? "- none" : entries.join("\n"),
    }),
  };
}

/** The worker's test-plan statuses with their evidence and its deviations, as data. */
function workerReportSection(report: NonNullable<ReviewTaskInput["workerReport"]>): string {
  const entries = report.testPlan
    .toSorted((a, b) => a.n - b.n)
    .map((entry) => `#${entry.n} ${entry.status}: ${entry.evidence.trim()}`);
  const deviations = report.deviations.map(
    (deviation) =>
      `${deviation.where.trim()}: ${deviation.what.trim()} Why: ${deviation.why.trim()}`,
  );
  // Worker text: data, so its prompt tags are neutralised by the template.
  return renderTemplate(workerReportTemplate, {
    entries: bullets(entries),
    deviations: bullets(deviations),
  });
}

function findingLine(finding: ReviewFinding): string {
  const where =
    finding.file === undefined
      ? ""
      : ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
  const refs = [
    ...(finding.criterion === undefined ? [] : [`criterion #${finding.criterion}`]),
    ...(finding.testEntry === undefined ? [] : [`test plan entry #${finding.testEntry}`]),
  ];
  const head = `- ${finding.severity} ${finding.kind}${where}${refs.length === 0 ? "" : ` (${refs.join(", ")})`}: ${finding.text.trim()}`;
  return finding.quote === undefined ? head : `${head}\n  quoted line: ${finding.quote.trim()}`;
}

/** The reviewer's read-only copy of the pushed commit (0021 section 10, DIPO-276). */
export interface ReviewCommitCopy {
  /** The pushed commit the copy holds. */
  readonly commit: string;
  /** The absolute path of the copy. */
  readonly dir: string;
}

/** The `commit` section: where the copy of the pushed commit is, after the other sections. */
export function reviewCommitSection(copy: ReviewCommitCopy): string {
  return renderTemplate(TASK_TEMPLATES.reviewCommit, { commit: copy.commit, dir: copy.dir });
}

/**
 * The review task message with its `commit` section last: dipo makes the copy when the session
 * starts, after the rest of the message is built (DIPO-276).
 */
export function withReviewCommit(message: string, copy: ReviewCommitCopy): string {
  return `${message.replace(/\n+$/, "")}\n\n${reviewCommitSection(copy)}\n`;
}

/**
 * Builds the `review` task message. Throws `ContractTooLargeError` (`prompt.contractTooLarge`)
 * when the story contract is over `contractMax`, as the `implement` message does.
 */
export function assembleReviewTaskMessage(input: ReviewTaskInput): ReviewTaskMessage {
  const { story } = input;
  const contract = assembleContract(story, input.contractMax ?? CONTRACT_MAX_DEFAULT);
  const own = (path: string) => path === story.taskFile;
  const changes = input.changes
    .filter((change) => !own(change.path))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = splitDiff(input.diff).filter((file) => !own(file.path));
  const diff = budgetedDiff(files, input.diffBudget, input.base);

  const sections = new Map<ReviewSectionName, string>();
  sections.set(
    "changes",
    renderTemplate(TASK_TEMPLATES.changes, { paths: bullets(changes.map(changeLine)) }),
  );
  sections.set("diff", renderTemplate(TASK_TEMPLATES.diff, { diff: diff.text }));
  if (input.gateChanges.length > 0) {
    sections.set(
      "gate_changes",
      renderTemplate(TASK_TEMPLATES.gateChanges, { changes: bullets(input.gateChanges) }),
    );
  }
  // The story facts of the contract, without the developer's extra instructions; the scope and
  // the test plan in the reviewer's words.
  for (const section of contract) {
    if (section.name === "story" || section.name === "outcome" || section.name === "criteria") {
      sections.set(section.name, section.text);
    }
    if (section.name === "answers") sections.set("answers", section.text);
  }
  sections.set(
    "scope",
    renderTemplate(TASK_TEMPLATES.reviewScope, { paths: bullets(story.scope) }),
  );
  const plan = testPlanSection(story);
  if (plan !== undefined) sections.set("test_plan", plan.text);
  if (input.workerReport !== undefined) {
    sections.set("worker_report", workerReportSection(input.workerReport));
  }
  const previous = input.previousFindings ?? [];
  if (input.previousFindings !== undefined) {
    sections.set(
      "previous_findings",
      renderTemplate(TASK_TEMPLATES.previousFindings, {
        // Model text from the previous round: data, so its prompt tags are neutralised.
        findings: previous.length === 0 ? "- none" : previous.map(findingLine).join("\n"),
      }),
    );
  }
  const ordered = REVIEW_SECTION_ORDER.flatMap((name) => {
    const text = sections.get(name);
    return text === undefined ? [] : [{ name, text }];
  });
  return {
    text: `${ordered.map((section) => section.text).join("\n\n")}\n`,
    sections: ordered,
    diffCut: diff.cut,
  };
}
