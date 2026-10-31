// The worker report as data (DIPO-186; 0008 section 1, 0014 section 2 and 0020 section 11, their
// notes of 2026-10-20, and 0021 section 7): code checks and stores what a report carries beyond
// its criteria, and never changes the story for it.
//
// - Test-plan entries (DIPO-254). A done report must give every automated entry of the story's
//   test plan the status done; an automated entry that is not done, or has no entry in the report,
//   refuses the done (`testPlanGaps`). Manual entries never block, and a story without a test plan
//   (or a spike) is not checked.
// - Decision notes. Each note's file must exist at the story branch and hold a section with that
//   heading (`noteMiss`); a note that passes is stored in `decision_notes`, one that misses is sent
//   back once and then left out.
// - Storage: every done report's test-plan entries and deviations (`done_reports`), the proposals
//   of every report (`proposals`, deduplicated by a hash of the title and the paths) and the
//   send-once marks (`report_sendbacks`). Storing changes nothing about the story's status, the
//   run's end or the commit.

import { createHash } from "node:crypto";

import {
  cleanText,
  type RunId,
  type StoryKey,
  type TestPlan,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type {
  WorkerDecisionNote,
  WorkerDeviation,
  WorkerProposal,
  WorkerTestPlanEntry,
} from "../workers/types";

// ---- test-plan entries ---------------------------------------------------------------------------

/** An automated test-plan entry a done report does not show as done. */
export interface TestPlanGap {
  /** Its number in the story's test plan, from 1 in field block order. */
  readonly n: number;
  readonly check: string;
  /** What the report said: not done, manual, or nothing at all. */
  readonly reported: "not-done" | "manual" | "missing";
}

/**
 * Pure: the automated entries of `plan` that `reported` does not mark done, in plan order. Empty
 * for a story without a test plan, a plan that does not apply, or a spike. Manual entries never
 * count, whatever the report says of them.
 */
export function testPlanGaps(
  plan: TestPlan | undefined,
  reported: readonly WorkerTestPlanEntry[] | undefined,
  type?: string,
): TestPlanGap[] {
  if (type?.toLowerCase() === "spike") return [];
  const entries = plan?.entries ?? [];
  const byNumber = new Map<number, WorkerTestPlanEntry>();
  for (const entry of reported ?? []) if (!byNumber.has(entry.n)) byNumber.set(entry.n, entry);
  const gaps: TestPlanGap[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== "automated") continue;
    const n = index + 1;
    const status = byNumber.get(n)?.status;
    if (status === "done") continue;
    gaps.push({ n, check: entry.check.trim(), reported: status ?? "missing" });
  }
  return gaps;
}

// ---- decision notes ------------------------------------------------------------------------------

/** Why a decision note cannot be placed: its file is missing, or no section has that heading. */
export type NoteMiss = "file" | "section";

const normal = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
/** A heading's leading number, as `7.` or `7`, which a note may leave out. */
const unnumbered = (text: string): string => text.replace(/^\d+(\.\d+)*\.?\s+/, "");

/** Pure: the section headings of a Markdown text, without their `#` marks. */
export function sectionHeadings(text: string): string[] {
  const headings: string[] = [];
  let fence = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined) headings.push(match[1]);
  }
  return headings;
}

/**
 * Pure: whether `section` names a heading of `text`: equal after whitespace and case are
 * normalised and leading `#` marks dropped, with or without the heading's leading number.
 */
export function hasSection(text: string, section: string): boolean {
  const wanted = normal(section.replace(/^\s*#+\s*/, ""));
  if (wanted === "") return false;
  return sectionHeadings(text).some((heading) => {
    const shown = normal(heading);
    return shown === wanted || unnumbered(shown) === unnumbered(wanted);
  });
}

/** Pure: why a note misses, given its file's text (null when the file is missing), or null. */
export function noteMiss(note: WorkerDecisionNote, fileText: string | null): NoteMiss | null {
  if (fileText === null) return "file";
  return hasSection(fileText, note.section) ? null : "section";
}

/**
 * Pure: the text under each heading that `section` names, up to the next heading of the same or a
 * higher level (fenced lines are never headings).
 */
export function sectionBodies(text: string, section: string): string[] {
  const wanted = normal(section.replace(/^\s*#+\s*/, ""));
  if (wanted === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headings: { line: number; level: number; matches: boolean }[] = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) return;
    const shown = normal(match[2]);
    const matches = shown === wanted || unnumbered(shown) === unnumbered(wanted);
    headings.push({ line: index, level: match[1].length, matches });
  });
  return headings.flatMap((heading, index) => {
    if (!heading.matches) return [];
    const next = headings.slice(index + 1).find((later) => later.level <= heading.level);
    return [lines.slice(heading.line + 1, next?.line ?? lines.length).join("\n")];
  });
}

/**
 * Pure: whether the decision record's text (null when the file is missing) already holds the
 * note's exact text under the section it names (DIPO-404): such a note is answered by the record.
 */
export function noteHeld(note: WorkerDecisionNote, fileText: string | null): boolean {
  if (fileText === null) return false;
  return sectionBodies(fileText, note.section).some((body) => body.includes(note.text));
}

/** The send-once signature of a note that missed: its file and section. */
export function noteSignature(note: WorkerDecisionNote): string {
  return hashOf([note.file, normal(note.section)]);
}

// ---- storage -------------------------------------------------------------------------------------

function hashOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** A done report's stored data: its test-plan entries and deviations. */
export interface StoredDoneReport {
  /** The done report's number in the run, from 1. */
  readonly report: number;
  readonly testPlan: readonly WorkerTestPlanEntry[];
  readonly deviations: readonly WorkerDeviation[];
  readonly at: number;
}

/** Stores one done report's test-plan entries and deviations; returns its number in the run. */
export function storeDoneReport(
  office: OfficeHandle,
  runId: RunId,
  input: {
    readonly testPlan?: readonly WorkerTestPlanEntry[];
    readonly deviations?: readonly WorkerDeviation[];
    readonly at: number;
  },
): number {
  const next =
    (office.get<{ n: number | null }>(
      "select max(report) as n from done_reports where office_id = $office_id and run_id = $run",
      { run: runId },
    )?.n ?? 0) + 1;
  office.run(
    `insert into done_reports (office_id, run_id, report, test_plan, deviations, at)
     values ($office_id, $run, $report, $plan, $deviations, $at)`,
    {
      run: runId,
      report: next,
      plan: JSON.stringify(input.testPlan ?? []),
      deviations: JSON.stringify(input.deviations ?? []),
      at: input.at,
    },
  );
  return next;
}

/** Every done report of the run, oldest first. */
export function doneReports(office: OfficeHandle, runId: RunId): StoredDoneReport[] {
  return office
    .all<{ report: number; test_plan: string; deviations: string; at: number }>(
      `select report, test_plan, deviations, at from done_reports
        where office_id = $office_id and run_id = $run order by report`,
      { run: runId },
    )
    .map((row) => ({
      report: row.report,
      testPlan: JSON.parse(row.test_plan) as WorkerTestPlanEntry[],
      deviations: JSON.parse(row.deviations) as WorkerDeviation[],
      at: row.at,
    }));
}

/** The run's newest done report, or null when it has none. */
export function latestDoneReport(office: OfficeHandle, runId: RunId): StoredDoneReport | null {
  const row = office.get<{ report: number; test_plan: string; deviations: string; at: number }>(
    `select report, test_plan, deviations, at from done_reports
      where office_id = $office_id and run_id = $run order by report desc limit 1`,
    { run: runId },
  );
  if (row === null) return null;
  return {
    report: row.report,
    testPlan: JSON.parse(row.test_plan) as WorkerTestPlanEntry[],
    deviations: JSON.parse(row.deviations) as WorkerDeviation[],
    at: row.at,
  };
}

/** What dipo sends back to the worker at most once per run. */
export type SendBackKind = "decision-note";

/** True when `kind` with `signature` was already sent back in the run. */
export function sentBack(
  office: OfficeHandle,
  runId: RunId,
  kind: SendBackKind,
  signature: string,
): boolean {
  return (
    office.get(
      `select 1 as found from report_sendbacks where office_id = $office_id and run_id = $run
        and kind = $kind and signature = $signature`,
      { run: runId, kind, signature },
    ) !== null
  );
}

/** Records that `kind` with `signature` was sent back in the run. */
export function recordSendBack(
  office: OfficeHandle,
  runId: RunId,
  kind: SendBackKind,
  signature: string,
  at: number,
): void {
  office.run(
    `insert or ignore into report_sendbacks (office_id, run_id, kind, signature, at)
     values ($office_id, $run, $kind, $signature, $at)`,
    { run: runId, kind, signature, at },
  );
}

/** The dedupe hash of a proposal: its title and its paths, sorted. */
export function proposalHash(proposal: Pick<WorkerProposal, "title" | "paths">): string {
  return hashOf([proposal.title.trim(), ...[...(proposal.paths ?? [])].toSorted()]);
}

/** The longest title a `proposal.filed` event carries, in characters (the report's own cap). */
const FILED_TITLE_MAX = 120;

/**
 * Stores a report's proposals for the maintainer, state open; a proposal with the same title and
 * paths as a stored one is not stored again. Each stored one appends a `proposal.filed` entry
 * (DIPO-166) in the caller's transaction, its title cleaned and on one line. Returns how many rows
 * were added.
 */
export function storeProposals(
  office: OfficeHandle,
  input: {
    readonly key: StoryKey;
    readonly runId: RunId;
    readonly proposals: readonly WorkerProposal[];
    readonly at: number;
  },
): number {
  const story =
    office.get<{ story_id: string }>(
      "select story_id from stories where office_id = $office_id and key = $key",
      { key: input.key },
    )?.story_id ?? null;
  const filed: NewEntry[] = [];
  for (const proposal of input.proposals) {
    const hash = proposalHash(proposal);
    const changes = office.run(
      `insert into proposals (office_id, hash, story_key, run_id, kind, title, outcome, why, paths,
         created_at, updated_at)
       values ($office_id, $hash, $key, $run, $kind, $title, $outcome, $why, $paths, $at, $at)
       on conflict (office_id, hash) do nothing`,
      {
        hash,
        key: input.key,
        run: input.runId,
        kind: proposal.kind,
        title: proposal.title,
        outcome: proposal.outcome,
        why: proposal.why,
        paths: JSON.stringify(proposal.paths ?? []),
        at: input.at,
      },
    ).changes;
    if (changes === 0) continue;
    filed.push({
      type: "proposal.filed",
      key: input.key,
      run: input.runId,
      delta: {
        proposal: hash,
        kind: proposal.kind,
        key: input.key,
        ...(story === null ? {} : { story }),
        run: input.runId,
        title: filedTitle(proposal.title),
      },
    });
  }
  appendEntries(office, filed, { at: input.at });
  return filed.length;
}

/** A worker's title as an event carries it: cleaned, on one line and capped. */
function filedTitle(title: string): string {
  const chars = Array.from(cleanText(title).replace(/\s+/g, " ").trim());
  return chars.length <= FILED_TITLE_MAX
    ? chars.join("")
    : `${chars.slice(0, FILED_TITLE_MAX - 1).join("")}…`;
}

/** The key of a stored decision note: its story, file, section and text. */
export function decisionNoteHash(key: StoryKey, note: WorkerDecisionNote): string {
  return hashOf([key, note.file, normal(note.section), note.text.trim()]);
}

/**
 * Stores checked decision notes for the maintainer, state open; the same note of the same story
 * again is not stored twice. dipo never writes them to the decision records.
 */
export function storeDecisionNotes(
  office: OfficeHandle,
  input: {
    readonly key: StoryKey;
    readonly runId: RunId;
    readonly notes: readonly WorkerDecisionNote[];
    readonly at: number;
  },
): number {
  let added = 0;
  for (const note of input.notes) {
    added += office.run(
      `insert into decision_notes (office_id, hash, story_key, run_id, file, section, text,
         created_at, updated_at)
       values ($office_id, $hash, $key, $run, $file, $section, $text, $at, $at)
       on conflict (office_id, hash) do nothing`,
      {
        hash: decisionNoteHash(input.key, note),
        key: input.key,
        run: input.runId,
        file: note.file,
        section: note.section,
        text: note.text,
        at: input.at,
      },
    ).changes;
  }
  return added;
}
