// Criteria progress of a story run (DIPO-85; 0008 section 3, 0007 section 4, migration 24).
//
// The run start records the criterion numbers the story has and the ones already checked. Each
// turn report the engine accepts replaces the reported set with the known numbers it marks met;
// a number the story does not have is ignored. `Progress.criteriaMet` counts the union of the two,
// so the TUI, `dipo watch` and the overview see progress while the run is live, before the merge
// brings the checks to the base index. The count stays a worker claim (0009 section 3 evidence
// `claimed`): the engine only filters it against the story, it never verifies it.
//
// Writers run inside the caller's `office.immediate`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { WorkerReport } from "../workers/types";

/** The story's criteria when the run started. */
export interface RunCriteria {
  readonly known: readonly number[];
  readonly checked: readonly number[];
}

interface CriteriaRow {
  known: string | null;
  checked: string | null;
  reported: string | null;
}

function numbers(text: string | null): number[] {
  return text === null ? [] : (JSON.parse(text) as number[]);
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b);
}

function criteriaRow(office: OfficeHandle, runId: string): CriteriaRow | null {
  return office.get<CriteriaRow>(
    `select criteria_known as known, criteria_checked as checked, criteria_reported as reported
      from runs where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
}

/** Stores the story's criteria at run start. */
export function recordRunCriteria(office: OfficeHandle, runId: RunId, criteria: RunCriteria): void {
  office.run(
    `update runs set criteria_known = $known, criteria_checked = $checked
      where office_id = $office_id and run_id = $run`,
    {
      run: runId,
      known: JSON.stringify(sortedUnique(criteria.known)),
      checked: JSON.stringify(sortedUnique(criteria.checked)),
    },
  );
}

/**
 * Stores the known criteria an accepted report marks met as the run's reported set. True when
 * the count of met criteria changed; false for a run that recorded no criteria at start.
 */
export function recordReportedCriteria(
  office: OfficeHandle,
  runId: string,
  report: WorkerReport,
): boolean {
  const row = criteriaRow(office, runId);
  if (row === null || row.known === null) return false;
  const known = new Set(numbers(row.known));
  const reported = sortedUnique(
    report.criteria.filter((c) => c.met && known.has(c.n)).map((c) => c.n),
  );
  const met = JSON.stringify(reported);
  if (met === row.reported) return false;
  office.run(
    `update runs set criteria_reported = $met where office_id = $office_id and run_id = $run`,
    { run: runId, met },
  );
  return metCount(row.checked, reported) !== metCount(row.checked, numbers(row.reported));
}

function metCount(checked: string | null, reported: readonly number[]): number {
  return new Set([...numbers(checked), ...reported]).size;
}

/**
 * The criteria of the run met so far, checked at start or marked met by the latest accepted
 * report, and how many the story had at start; null for a run that recorded none.
 */
export function runCriteriaMet(
  office: OfficeHandle,
  runId: string,
): { readonly met: number; readonly known: number } | null {
  const row = criteriaRow(office, runId);
  if (row === null || row.known === null) return null;
  return { met: metCount(row.checked, numbers(row.reported)), known: numbers(row.known).length };
}
