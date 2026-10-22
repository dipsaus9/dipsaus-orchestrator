// The live agent detail of a run that already ended, opened from a story that is not running
// (DIPO-81): its header and facts come from the stored run (`story.detail` runs: role, tier,
// model, start, end, outcome and usage), since the engine sends no `WorkView` for an ended run.
// When the stored output is gone the pane says why rather than looking empty.

import type { RunRecord, StoryView } from "@dipsaus-orchestrator/contract";

import { age, elapsed, tokens } from "./format";

/** `DIPO-28 Show the merge queue · developer · L · claude-haiku · run_01J…`. */
export function recordHeaderLine(
  record: RunRecord,
  story: StoryView | undefined,
  dot: string,
): string {
  const title = story === undefined ? "" : `${story.story} ${story.title}`;
  return [title, record.role, record.tier, record.model, String(record.run)]
    .filter((part) => part !== "")
    .join(` ${dot} `);
}

function ended(record: RunRecord, now: number): string {
  if (record.endedAt === undefined) return "ended";
  const outcome = record.outcome === undefined ? "" : ` (${record.outcome})`;
  return `ended ${age(now - Date.parse(record.endedAt))} ago${outcome}`;
}

function usageParts(record: RunRecord) {
  const { usage } = record;
  return {
    io: `in ${tokens(usage.inputTokens)} out ${tokens(usage.outputTokens)}`,
    cache: `cw ${tokens(usage.cacheCreateTokens)} cr ${tokens(usage.cacheReadTokens)}`,
    turns: `turns ${usage.turns}`,
    cost: usage.estimatedCost === undefined ? "" : `~$${usage.estimatedCost.toFixed(2)}`,
    time: elapsed(usage.elapsedMs),
  };
}

/** The most lines of the done report the facts column holds (DIPO-152). */
const DONE_REPORT_LINES = 6;

/**
 * The ended run's done report as fact lines, marked as the worker's words and held to a few lines;
 * the rest stays in the story detail (DIPO-152).
 */
export function doneReportFactLines(record: RunRecord): string[] {
  const report = record.doneReport;
  if (report === undefined) return [];
  const lines = [
    ...(report.notes === undefined
      ? []
      : report.notes.split("\n").filter((line) => line.trim() !== "")),
    ...(report.proposals ?? []).map((proposal) => `proposal (${proposal.kind}): ${proposal.title}`),
  ];
  return ["worker's done report (its words):", ...lines.slice(0, DONE_REPORT_LINES - 1)];
}

/** The stored run's facts as labelled lines, for the side-by-side layout. */
export function recordFactLines(record: RunRecord, now: number): string[] {
  const u = usageParts(record);
  return [
    `run      ${ended(record, now)}`,
    `role     ${record.role}`,
    `model    ${record.model}`,
    `time     ${u.time}`,
    `usage    ${u.io}`,
    `         ${u.cache}`,
    `         ${u.turns}${u.cost === "" ? "" : `  ${u.cost}`}`,
    ...doneReportFactLines(record),
  ];
}

/** The stored run's facts in two lines, for the stacked layout below 100 columns. */
export function compactRecordFactLines(record: RunRecord, now: number): string[] {
  const u = usageParts(record);
  const cost = u.cost === "" ? "" : ` ${u.cost}`;
  return [
    `run ${ended(record, now)}  role ${record.role}  model ${record.model}  time ${u.time}`,
    `usage ${u.io} ${u.cache} ${u.turns}${cost}`,
    ...doneReportFactLines(record),
  ];
}

/**
 * What an empty pane of an ended run says: output of a run that ended longer ago than the office's
 * retention period (`OfficeSummary.outputRetentionDays`, 0007 section 7) was removed; otherwise,
 * or when the summary does not send the period, nothing was stored for this source.
 */
export function noOutputLine(
  endedAt: string | undefined,
  now: number,
  retentionDays: number | undefined,
): string {
  if (endedAt === undefined || retentionDays === undefined) return "no output stored";
  const days = (now - Date.parse(endedAt)) / 86_400_000;
  return days > retentionDays ? "output removed after the retention period" : "no output stored";
}
