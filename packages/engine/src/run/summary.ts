// The structured summary dipo writes onto a story on park, resume and close (ADR 0020 section 13,
// 0001: git carries the highlights of every story's runs). Code builds every line from stored
// facts; no model is asked. `backlog/fields/summary.ts` writes it through the Backlog CLI:
//
// - On park, in the task-file commit that writes F16 (`gitParkWriter`), one implementation-notes
//   block: date, reason, the detail on one line, run id, criteria met of total (as the
//   worker reported them), loops of cap and CI attempts of cap, review rounds and failed rounds,
//   budget used of limit per cap (tokens, turns, minutes), the last good commit and the number of
//   uncommitted files.
// - On resume, in the unpark commit (`gitUnparkWriter`), one line: date, resumed, the grants of the
//   resume and the first line of the note.
// - On close, in the merge slot's close-out commit (0019 section 9 step 1, `merge-slot/close-out.ts`),
//   the final summary: criteria met, loops, review rounds, budget used of limit, runs and resumes,
//   each park in one line, grants, web calls and proposals filed.
//
// A box run (0021): CI is its verify, so its CI attempts stand next to the loops; its undelivered
// work stays in the box, so the park block does not count uncommitted files from the Mac worktree
// (whose files stay at the start commit) and says so.
//
// No written line is a line of dashes: free text (a park detail, a note) is cut to one line, and a
// line of only `-` is replaced, so the runner's 50-dash refusal (0010) never fires on a summary.

import type { RunId } from "@dipsaus-orchestrator/contract";

import { formatCount } from "../context/truncate";
import type { OfficeHandle } from "../db/office";

import { runCaps, runTotals } from "./caps";
import { runCriteriaMet } from "./criteria";
import type { GrantAmount, RoundCap } from "./grants";
import { hasTable } from "./open-feedback";
import { capsStartedAt, findRun, runRoundCounts, type StoredRun } from "./records";

/** The longest free text (a park detail, a note) a summary line carries. */
export const SUMMARY_TEXT_MAX = 200;

/** A time as the summary prints it: `2026-10-22 14:05 UTC`. */
export function summaryDate(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Free text on one line: its first non-empty line, whitespace collapsed, cut to `max` characters
 * with an ellipsis; a line of only dashes (a Backlog section rule) is replaced, and an HTML comment
 * mark is broken up, so a worker's text can never close the task file's section markers
 * (`<!-- SECTION:NOTES:END -->`). Empty stays empty.
 */
export function oneLine(text: string, max = SUMMARY_TEXT_MAX): string {
  const first =
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) =>
        line.replace(/\s+/g, " ").replaceAll("<!--", "<! --").replaceAll("-->", "-- >").trim(),
      )
      .find((line) => line !== "") ?? "";
  if (/^-+$/.test(first)) return "(a line of dashes)";
  if (first.length <= max) return first;
  let cut = first.slice(0, max - 1).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Used of a limit; a run without that cap has a null or unbounded limit. */
interface UsedOf {
  readonly used: number;
  readonly limit: number | null;
}

/** `412,000 of 300,000 tokens`, or `412,000 tokens (no cap)` when the limit is unbounded. */
function usedOf(value: UsedOf, unit?: string): string {
  const used = formatCount(Math.round(value.used));
  const suffix = unit === undefined ? "" : ` ${unit}`;
  if (value.limit === null || !Number.isFinite(value.limit)) return `${used}${suffix} (no cap)`;
  return `${used} of ${formatCount(Math.round(value.limit))}${suffix}`;
}

/** The facts of one park block, all read from the database except the branch's own. */
export interface ParkBlockFacts {
  readonly at: number;
  readonly reason: string;
  readonly detail: string;
  readonly runId: string;
  /** Criteria met as the worker reported them, of the story's criteria; null when not recorded. */
  readonly criteria: { readonly met: number; readonly known: number } | null;
  readonly loops: UsedOf;
  readonly ciAttempts: UsedOf;
  readonly reviewRounds: {
    readonly started: number;
    readonly failed: number;
    readonly cap: number | null;
  };
  readonly budget: { readonly tokens: UsedOf; readonly turns: UsedOf; readonly minutes: UsedOf };
  /** The branch tip before the park commit; null when it was not read. */
  readonly lastGoodCommit: string | null;
  /** Uncommitted and untracked files of the worktree; null for a box run, whose work is in the box. */
  readonly uncommitted: number | null;
}

/** The first host start of the run, for the time its caps count from. */
function firstHostStart(office: OfficeHandle, runId: string): number | null {
  return (
    office.get<{ started_at: number | null }>(
      `select min(started_at) as started_at from worker_hosts
        where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.started_at ?? null
  );
}

/** A run's counts and budget as of `at`, the part of a park block the database holds. */
export function runSummaryFacts(
  office: OfficeHandle,
  run: StoredRun,
  at: number,
): Pick<ParkBlockFacts, "criteria" | "loops" | "ciAttempts" | "reviewRounds" | "budget"> {
  const caps = runCaps(office, run);
  const rounds = runRoundCounts(office, run.runId);
  const totals = runTotals(
    office,
    run.runId as RunId,
    capsStartedAt(run, firstHostStart(office, run.runId)),
    at,
  );
  return {
    criteria: runCriteriaMet(office, run.runId, null),
    loops: { used: rounds.loops, limit: caps.loopCap },
    ciAttempts: { used: rounds.ciAttempts, limit: caps.ciCap },
    reviewRounds: {
      started: rounds.reviewRounds,
      failed: rounds.reviewRoundsFailed,
      cap: caps.reviewRoundCap,
    },
    budget: {
      tokens: { used: totals.budgetTokens, limit: caps.budgetTokens },
      turns: { used: totals.turns, limit: caps.maxTurns },
      minutes: { used: totals.elapsedMs / 60_000, limit: caps.maxMinutes },
    },
  };
}

function criteriaText(criteria: ParkBlockFacts["criteria"]): string {
  return criteria === null
    ? "not recorded"
    : `${criteria.met} of ${criteria.known} (as the worker reported them)`;
}

/** The implementation-notes block of a park. */
export function renderParkBlock(facts: ParkBlockFacts): string {
  const rounds = facts.reviewRounds;
  const detail = oneLine(facts.detail);
  return [
    `Parked ${summaryDate(facts.at)}: ${facts.reason}`,
    `- Detail: ${detail === "" ? "none" : detail}`,
    `- Run: ${facts.runId}`,
    `- Criteria met: ${criteriaText(facts.criteria)}`,
    `- Loops: ${usedOf(facts.loops)}; CI attempts: ${usedOf(facts.ciAttempts)}`,
    `- Review rounds: ${rounds.started}, failed ${rounds.failed}${rounds.cap === null ? "" : ` of ${rounds.cap}`}`,
    `- Budget used: ${usedOf(facts.budget.tokens, "tokens")}; ${usedOf(facts.budget.turns, "turns")}; ${usedOf(facts.budget.minutes, "minutes")}`,
    `- Last good commit: ${facts.lastGoodCommit ?? "not read"}`,
    `- Uncommitted files: ${facts.uncommitted === null ? "not counted (a box run: undelivered work stays in the box)" : facts.uncommitted}`,
  ].join("\n");
}

/** One grant as a summary names it. */
export function grantText(grant: GrantAmount): string {
  switch (grant.kind) {
    case "budget":
      return `budget +${formatCount(grant.amount.tokens)} tokens, +${formatCount(grant.amount.turns)} turns, +${formatCount(grant.amount.minutes)} minutes`;
    case "round":
      return `+${grant.amount.count} ${ROUND_NAMES[grant.amount.cap]}`;
  }
}

/** A counted cap as a summary names one more round of it. */
const ROUND_NAMES: Readonly<Record<RoundCap, string>> = {
  loops: "loop",
  reviewRounds: "review round",
  ciAttempts: "CI attempt",
  conflictAttempts: "conflict hand-off",
};

export interface ResumeLineFacts {
  readonly at: number;
  /** The grants the resume records (0020 section 5); none for most resumes. */
  readonly grants: readonly GrantAmount[];
  /** The maintainer's note; its first line is written. */
  readonly note?: string;
  /** The decision of a permission or scope answer that resumed the park, for example `allow once`. */
  readonly answer?: string;
}

/** The one implementation-notes line of a resume. */
export function resumeLine(facts: ResumeLineFacts): string {
  const grants = facts.grants.length === 0 ? "none" : facts.grants.map(grantText).join(", ");
  const note = oneLine(facts.note ?? "");
  return [
    `Resumed ${summaryDate(facts.at)}`,
    ...(facts.answer === undefined ? [] : [`answer: ${oneLine(facts.answer)}`]),
    `grants: ${grants}`,
    `note: ${note === "" ? "none" : note}`,
  ].join("; ");
}

/** The facts of a story's final summary, over every run of the story. */
export interface FinalSummaryFacts {
  readonly at: number;
  readonly criteria: { readonly met: number; readonly known: number } | null;
  readonly loops: number;
  readonly ciAttempts: number;
  readonly reviewRounds: number;
  readonly reviewRoundsFailed: number;
  readonly budget: UsedOf;
  readonly runs: number;
  readonly resumes: number;
  readonly parks: readonly {
    readonly at: number;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly grants: readonly { readonly at: number; readonly grant: GrantAmount }[];
  readonly web: { readonly searches: number; readonly fetches: number };
  /** Proposals filed from the story's reports; null where the database keeps none. */
  readonly proposals: number | null;
}

/** The story runs of a story key, oldest first. */
function storyRuns(office: OfficeHandle, key: string): StoredRun[] {
  return office
    .all<{ run_id: string }>(
      `select run_id from runs where office_id = $office_id and key = $key and kind = 'story'
        order by started_at, run_id`,
      { key },
    )
    .map((row) => findRun(office, row.run_id as RunId))
    .filter((run): run is StoredRun => run !== null);
}

/** Reads a story's final summary facts as of `at`. */
export function finalSummaryFacts(
  office: OfficeHandle,
  key: string,
  at: number,
): FinalSummaryFacts {
  const runs = storyRuns(office, key);
  let loops = 0;
  let ciAttempts = 0;
  let reviewRounds = 0;
  let reviewRoundsFailed = 0;
  let used = 0;
  let limit = 0;
  for (const run of runs) {
    const rounds = runRoundCounts(office, run.runId);
    loops += rounds.loops;
    ciAttempts += rounds.ciAttempts;
    reviewRounds += rounds.reviewRounds;
    reviewRoundsFailed += rounds.reviewRoundsFailed;
    used += runTotals(office, run.runId, run.startedAt, run.startedAt).budgetTokens;
    limit += runCaps(office, run).budgetTokens;
  }
  const last = runs.at(-1);
  // History (0007): each park with the reason it was made with, not the current park (DIPO-360).
  const parks = office
    .all<{ at: number; reason: string; detail: string }>(
      `select at, reason, detail from parks where office_id = $office_id and key = $key
        order by park_id`,
      { key },
    )
    .map((row) => ({ at: row.at, reason: row.reason, detail: row.detail }));
  const resumes =
    office.get<{ n: number }>(
      `select count(*) as n from parks where office_id = $office_id and key = $key
        and resolved_how = 'resume'`,
      { key },
    )?.n ?? 0;
  const grants = office
    .all<{ at: number; kind: GrantAmount["kind"]; amount: string }>(
      `select g.at, g.kind, g.amount from run_grants g
        join runs r on r.office_id = g.office_id and r.run_id = g.run_id
        where g.office_id = $office_id and r.key = $key order by g.at, g.grant_id`,
      { key },
    )
    .map((row) => ({
      at: row.at,
      grant: { kind: row.kind, amount: JSON.parse(row.amount) as never } as GrantAmount,
    }));
  const web = office.get<{ searches: number | null; fetches: number | null }>(
    `select sum(web_searches) as searches, sum(web_fetches) as fetches from runs
      where office_id = $office_id and key = $key and kind = 'story'`,
    { key },
  );
  const proposals = hasTable(office, "proposals")
    ? (office.get<{ n: number }>(
        `select count(*) as n from proposals where office_id = $office_id and story_key = $key`,
        { key },
      )?.n ?? 0)
    : null;
  return {
    at,
    criteria: last === undefined ? null : runCriteriaMet(office, last.runId, null),
    loops,
    ciAttempts,
    reviewRounds,
    reviewRoundsFailed,
    budget: { used, limit: runs.length === 0 ? null : limit },
    runs: runs.length,
    resumes,
    parks,
    grants,
    web: { searches: web?.searches ?? 0, fetches: web?.fetches ?? 0 },
    proposals,
  };
}

/** The final summary text of a story. */
export function renderFinalSummary(facts: FinalSummaryFacts): string {
  const parks = facts.parks.map((park) => {
    const detail = oneLine(park.detail);
    return `  - ${summaryDate(park.at)} ${park.reason}${detail === "" ? "" : `: ${detail}`}`;
  });
  const grants = facts.grants.map(
    (entry) => `  - ${summaryDate(entry.at)} ${grantText(entry.grant)}`,
  );
  return [
    `Closed ${summaryDate(facts.at)}`,
    `- Criteria met: ${criteriaText(facts.criteria)}`,
    `- Loops: ${facts.loops}; CI attempts: ${facts.ciAttempts}`,
    `- Review rounds: ${facts.reviewRounds}, failed ${facts.reviewRoundsFailed}`,
    `- Budget used: ${usedOf(facts.budget, "tokens")}`,
    `- Runs: ${facts.runs}; resumes: ${facts.resumes}`,
    `- Parks: ${facts.parks.length === 0 ? "none" : facts.parks.length}`,
    ...parks,
    `- Grants: ${facts.grants.length === 0 ? "none" : facts.grants.length}`,
    ...grants,
    `- Web calls: ${facts.web.searches} searches, ${facts.web.fetches} fetches`,
    `- Proposals filed: ${facts.proposals === null ? "not recorded" : facts.proposals}`,
  ].join("\n");
}

/** A story's final summary as of `at`, from stored facts. */
export function finalSummaryOf(office: OfficeHandle, key: string, at: number): string {
  return renderFinalSummary(finalSummaryFacts(office, key, at));
}
