// Run-end facts (DIPO-49; 0007 section 4): `run_summaries`. dipo stores no verify result of its own
// any more (DIPO-342: the box worker runs verify and CI checks), so a summary's `verify` is null.
// Writers run inside the caller's `office.immediate`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { WorkerReport } from "../workers/types";

/** Lines of output a run summary keeps (0007 section 4). */
export const SUMMARY_OUTPUT_LINES = 50;

/** The last `lines` lines of the run's stored output, worker and verify, in the order stored. */
export function outputTail(
  office: OfficeHandle,
  runId: RunId,
  lines: number = SUMMARY_OUTPUT_LINES,
): string {
  const chunks = office.all<{ text: string }>(
    `select text from output_chunks where office_id = $office_id and run_id = $run
      order by at desc, rowid desc limit 400`,
    { run: runId },
  );
  const kept: string[] = [];
  for (const chunk of chunks) {
    const split = chunk.text.replace(/\n$/, "").split("\n");
    for (let i = split.length - 1; i >= 0 && kept.length < lines; i--) kept.push(split[i] ?? "");
    if (kept.length >= lines) break;
  }
  return kept.toReversed().join("\n");
}

/** A run's summary (0007 section 4, `run_summaries`). */
export interface RunSummary {
  readonly report: WorkerReport | null;
  readonly diffstat: string;
  readonly verify: {
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly commands: readonly (readonly string[])[];
    readonly loop: number;
  } | null;
  readonly outputTail: string;
  readonly builtAt: number;
}

/**
 * Builds and stores the run's summary without a model: the final report, the diffstat and the last
 * 50 output lines. Once per run; a later call keeps the first.
 */
export function storeRunSummary(
  office: OfficeHandle,
  runId: RunId,
  input: { readonly report: WorkerReport | null; readonly diffstat: string; readonly at: number },
): void {
  office.run(
    `insert or ignore into run_summaries (office_id, run_id, report, diffstat, verify, output_tail,
       built_at)
     values ($office_id, $run, $report, $diffstat, null, $tail, $at)`,
    {
      run: runId,
      report: input.report === null ? null : JSON.stringify(input.report),
      diffstat: input.diffstat,
      tail: outputTail(office, runId),
      at: input.at,
    },
  );
}

/** The stored summary of a run, or null. */
export function runSummary(office: OfficeHandle, runId: RunId): RunSummary | null {
  const row = office.get<{
    report: string | null;
    diffstat: string;
    verify: string | null;
    output_tail: string;
    built_at: number;
  }>(
    `select report, diffstat, verify, output_tail, built_at from run_summaries
     where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null
    ? null
    : {
        report: row.report === null ? null : (JSON.parse(row.report) as WorkerReport),
        diffstat: row.diffstat,
        verify: row.verify === null ? null : (JSON.parse(row.verify) as RunSummary["verify"]),
        outputTail: row.output_tail,
        builtAt: row.built_at,
      };
}
