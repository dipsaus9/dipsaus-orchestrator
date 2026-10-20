// The base commit's verify result (DIPO-183; 0014 section 2, note of 2026-10-20). After a story
// worktree is set up, while it is still at the base commit and before the worker starts, setup runs
// the office's verify once in the worker's own sandbox (the read fence, `sandbox/fence.ts`) and
// stores what it said in `base_verifies`, keyed by office, base commit and configuration hash. Later
// runs on the same base read the row. The task message renders it as the `base_verify` section, so a
// worker never rebuilds a baseline to show that a failure is not its own.
//
// A verify that could not run (the sandbox did not start, it timed out or was killed, the run
// profile has no root verify, the worktree is not at the base commit) stores nothing; the section
// then says the result is not known and the next run on the base tries again.

import { configHash } from "../config";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { BASE_VERIFY_UNKNOWN, type BaseVerifyFacts } from "../prompts/base-verify";

/** The configuration a verify result depends on: where and how a step runs, and for how long. */
export type BaseVerifyConfig = Pick<OfficeConfig, "worktree" | "timeouts" | "sandbox">;

/** The configuration hash a stored result is keyed by: a change to these settings runs verify again. */
export function baseVerifyConfigHash(config: BaseVerifyConfig): string {
  return configHash({
    worktree: config.worktree,
    timeouts: config.timeouts,
    sandbox: config.sandbox,
  });
}

/** Characters of output tail stored when no failing test name could be read. */
export const OUTPUT_TAIL_STORED = 4_000;

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** `text` without terminal colour and cursor sequences. */
export function plainText(text: string): string {
  return text.replace(ANSI, "");
}

const FAIL_LINE = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/;

/**
 * The failing tests of a bun test run: the `(fail) <name> [1.2ms]` lines, each name once in the
 * order it first appears (bun prints each one again in its summary). Empty for any other runner.
 */
export function failingTests(output: string): string[] {
  const names: string[] = [];
  for (const line of plainText(output).split(/\r?\n/)) {
    const name = FAIL_LINE.exec(line)?.[1]?.trim();
    if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The end of `output` (plain text, trailing blank lines dropped), at most `max` characters. */
export function outputEnd(output: string, max: number = OUTPUT_TAIL_STORED): string {
  const text = plainText(output).replace(/\r\n?/g, "\n").trimEnd();
  return text.length > max ? text.slice(text.length - max) : text;
}

interface BaseVerifyRow {
  passed: number;
  failing: string;
  output_tail: string | null;
}

/** The stored result for a base commit, or null when none is stored. */
export function findBaseVerify(
  office: OfficeHandle,
  baseSha: string,
  hash: string,
): BaseVerifyFacts | null {
  const row = office.get<BaseVerifyRow>(
    `select passed, failing, output_tail from base_verifies
      where office_id = $office_id and base_sha = $base and config_hash = $hash`,
    { base: baseSha, hash },
  );
  if (row === undefined || row === null) return null;
  if (row.passed === 1) return { kind: "green" };
  return { kind: "red", failing: JSON.parse(row.failing) as string[], tail: row.output_tail };
}

/** The stored result for a base commit, or the not-known facts that say there is none. */
export function baseVerifyFactsOf(
  office: OfficeHandle,
  baseSha: string,
  hash: string,
): BaseVerifyFacts {
  return findBaseVerify(office, baseSha, hash) ?? BASE_VERIFY_UNKNOWN;
}

/** Stores a result that ran to the end; a result already stored for the key stays. */
export function storeBaseVerify(
  office: OfficeHandle,
  input: {
    readonly baseSha: string;
    readonly hash: string;
    readonly runId: string;
    readonly result: Extract<BaseVerifyFacts, { kind: "green" | "red" }>;
    readonly at: number;
  },
): void {
  const red = input.result.kind === "red" ? input.result : null;
  office.run(
    `insert into base_verifies (office_id, base_sha, config_hash, run_id, passed, failing,
       output_tail, ran_at)
     values ($office_id, $base, $hash, $run, $passed, $failing, $tail, $at)
     on conflict do nothing`,
    {
      base: input.baseSha,
      hash: input.hash,
      run: input.runId,
      passed: red === null ? 1 : 0,
      failing: JSON.stringify(red?.failing ?? []),
      tail: red === null || red.failing.length > 0 ? null : red.tail,
      at: input.at,
    },
  );
}
