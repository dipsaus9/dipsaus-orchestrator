// The notes and proposals of a run's done report (DIPO-152). The report is stored with the run
// summary when the run ends at In Review (`storeRunSummary`); this reads the worker's own words
// back for the views and the story PR. The report was cleaned and held to its caps at the door
// (`parseWorkerReport`), and every text is cleaned and capped again here, as door messages are
// (`cleanDoorText`), so a stored row of an older shape never shows more than the door allows.
// Deviations from the story are part of the notes: the report has no field of its own for them.

import type { DoneReport, RunId } from "@dipsaus-orchestrator/contract";

import { cleanDoorText } from "../box/door";
import type { OfficeHandle } from "../db/office";

import { runSummary } from "../records/verify-records";

/** The caps of the shown texts (characters), the same as the report schema's. */
export const DONE_REPORT_CAPS = {
  notes: 8_000,
  proposals: 3,
  title: 120,
  outcome: 500,
  why: 1_000,
  paths: 20,
  path: 300,
} as const;

const caps = DONE_REPORT_CAPS;

const clean = (text: string, max: number): string => cleanDoorText(text).trim().slice(0, max);

/** Pure: the notes and proposals of a done report, cleaned and capped; null when it has none. */
export function doneReportOf(
  report: {
    readonly notes?: string | undefined;
    readonly proposals?: readonly {
      readonly kind: string;
      readonly title: string;
      readonly outcome: string;
      readonly why: string;
      readonly paths?: readonly string[] | undefined;
    }[];
  } | null,
): DoneReport | null {
  if (report === null) return null;
  const notes = report.notes === undefined ? "" : clean(report.notes, caps.notes);
  const proposals = (report.proposals ?? []).slice(0, caps.proposals).map((proposal) => ({
    kind: clean(proposal.kind, 20),
    title: clean(proposal.title, caps.title),
    outcome: clean(proposal.outcome, caps.outcome),
    why: clean(proposal.why, caps.why),
    ...(proposal.paths === undefined || proposal.paths.length === 0
      ? {}
      : { paths: proposal.paths.slice(0, caps.paths).map((path) => clean(path, caps.path)) }),
  }));
  if (notes === "" && proposals.length === 0) return null;
  return { ...(notes === "" ? {} : { notes }), ...(proposals.length === 0 ? {} : { proposals }) };
}

/** The stored done report of the run, or null when the run stored none or it has no notes. */
export function storedDoneReport(office: OfficeHandle, runId: RunId): DoneReport | null {
  return doneReportOf(runSummary(office, runId)?.report ?? null);
}
