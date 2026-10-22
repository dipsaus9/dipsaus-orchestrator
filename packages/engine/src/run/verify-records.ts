// Verify and run-end facts (DIPO-49; 0007 section 4): `verify_results`, the verify output in
// `output_chunks` (source `verify`) and `run_summaries`. Writers run inside the caller's
// `office.immediate`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { byteLength } from "../ingest/output";
import type { WorkerReport } from "../workers/types";

/** Which run profile a verify command list came from (0013 section 5). */
export type VerifyProfile = "branch" | "base";

export interface NewVerifyResult {
  readonly loop: number;
  readonly profile: VerifyProfile;
  readonly commands: readonly (readonly string[])[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly passed: boolean;
  readonly durationMs: number;
  /** The byte range of its output in `output_chunks` (source `verify`). */
  readonly outputFrom: number;
  readonly outputTo: number;
  readonly at: number;
  /**
   * A box verify that passed with failing tests that also fail at the start commit in the same
   * box image (DIPO-294): those tests. Absent or null for every other result.
   */
  readonly baseFailures?: readonly string[] | null;
}

export interface StoredVerifyResult extends NewVerifyResult {
  readonly resultId: number;
  readonly baseFailures: readonly string[] | null;
  readonly codeTreeKey: string | null;
}

interface VerifyRow {
  result_id: number;
  loop: number;
  profile: VerifyProfile;
  commands: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  passed: number;
  duration_ms: number;
  output_from: number;
  output_to: number;
  code_tree_key: string | null;
  base_failures: string | null;
  at: number;
}

function toResult(row: VerifyRow): StoredVerifyResult {
  return {
    resultId: row.result_id,
    loop: row.loop,
    profile: row.profile,
    commands: JSON.parse(row.commands) as string[][],
    exitCode: row.exit_code,
    signal: row.signal,
    timedOut: row.timed_out === 1,
    passed: row.passed === 1,
    durationMs: row.duration_ms,
    outputFrom: row.output_from,
    outputTo: row.output_to,
    codeTreeKey: row.code_tree_key,
    baseFailures: row.base_failures === null ? null : (JSON.parse(row.base_failures) as string[]),
    at: row.at,
  };
}

export function insertVerifyResult(
  office: OfficeHandle,
  runId: RunId,
  result: NewVerifyResult,
): number {
  const id =
    office.get<{ id: number }>(
      `select coalesce(max(result_id), 0) + 1 as id from verify_results
       where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.id ?? 1;
  office.run(
    `insert into verify_results (office_id, run_id, result_id, loop, profile, commands, exit_code,
       signal, timed_out, passed, duration_ms, output_from, output_to, base_failures, at)
     values ($office_id, $run, $id, $loop, $profile, $commands, $exit, $signal, $timed_out,
       $passed, $duration, $from, $to, $base, $at)`,
    {
      run: runId,
      id,
      loop: result.loop,
      profile: result.profile,
      commands: JSON.stringify(result.commands),
      exit: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut ? 1 : 0,
      passed: result.passed ? 1 : 0,
      duration: result.durationMs,
      from: result.outputFrom,
      to: result.outputTo,
      base: result.baseFailures == null ? null : JSON.stringify(result.baseFailures),
      at: result.at,
    },
  );
  return id;
}

/** The run's verify results, oldest first. */
export function verifyResults(office: OfficeHandle, runId: RunId): StoredVerifyResult[] {
  return office
    .all<VerifyRow>(
      `select result_id, loop, profile, commands, exit_code, signal, timed_out, passed,
         duration_ms, output_from, output_to, code_tree_key, base_failures, at
       from verify_results where office_id = $office_id and run_id = $run order by result_id`,
      { run: runId },
    )
    .map(toResult);
}

/** Records the code tree key (0010 section 7) on the green results of `loop`. */
export function recordCodeTreeKey(
  office: OfficeHandle,
  runId: RunId,
  loop: number,
  key: string,
): void {
  office.run(
    `update verify_results set code_tree_key = $key
     where office_id = $office_id and run_id = $run and loop = $loop and passed = 1`,
    { run: runId, loop, key },
  );
}

/** Where the run's verify output ends, in bytes. */
export function verifyOutputEnd(office: OfficeHandle, runId: RunId): number {
  return (
    office.get<{ end: number | null }>(
      `select max(to_offset) as end from output_chunks
       where office_id = $office_id and run_id = $run and source = 'verify'`,
      { run: runId },
    )?.end ?? 0
  );
}

/** Stores one piece of verify output and returns its byte range. */
export function appendVerifyOutput(
  office: OfficeHandle,
  runId: RunId,
  text: string,
  at: number,
): { readonly from: number; readonly to: number } {
  const from = verifyOutputEnd(office, runId);
  const to = from + byteLength(text);
  office.run(
    `insert into output_chunks (office_id, run_id, source, from_offset, to_offset, agent_id, text,
       at)
     values ($office_id, $run, 'verify', $from, $to, null, $text, $at)`,
    { run: runId, from, to, text, at },
  );
  return { from, to };
}

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
    /** The tests that also failed on the base in the box, for a pass with base failures. */
    readonly baseFailures?: readonly string[];
  } | null;
  readonly outputTail: string;
  readonly builtAt: number;
}

/**
 * Builds and stores the run's summary without a model: the final report, the diffstat, the last
 * verify result and the last 50 output lines. Once per run; a later call keeps the first.
 */
export function storeRunSummary(
  office: OfficeHandle,
  runId: RunId,
  input: { readonly report: WorkerReport | null; readonly diffstat: string; readonly at: number },
): void {
  const last = verifyResults(office, runId).at(-1);
  const verify =
    last === undefined
      ? null
      : {
          passed: last.passed,
          exitCode: last.exitCode,
          timedOut: last.timedOut,
          commands: last.commands,
          loop: last.loop,
          ...(last.baseFailures === null ? {} : { baseFailures: last.baseFailures }),
        };
  office.run(
    `insert or ignore into run_summaries (office_id, run_id, report, diffstat, verify, output_tail,
       built_at)
     values ($office_id, $run, $report, $diffstat, $verify, $tail, $at)`,
    {
      run: runId,
      report: input.report === null ? null : JSON.stringify(input.report),
      diffstat: input.diffstat,
      verify: verify === null ? null : JSON.stringify(verify),
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

/**
 * The failing tests the run's last verify passed with because they also fail at the start commit
 * in its box (DIPO-294); empty when the last verify was plain green or red.
 */
export function lastBaseFailures(office: OfficeHandle, runId: RunId): readonly string[] {
  const last = verifyResults(office, runId).at(-1);
  return last?.passed === true ? (last.baseFailures ?? []) : [];
}
