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
import type { RunProfile } from "../scan/detect";
import { storedProfile } from "../scan/store";

/** The configuration a verify result depends on: where and how a step runs, and for how long. */
export type BaseVerifyConfig = Pick<OfficeConfig, "worktree" | "timeouts" | "sandbox">;

/**
 * The configuration hash a stored result is keyed by: a change to these settings, or to the verify
 * commands of the run profile (a confirmed capability or a rescan), runs verify again.
 */
export function baseVerifyConfigHash(config: BaseVerifyConfig, profile: RunProfile | null): string {
  const verify = profile?.capabilities.verify;
  return configHash({
    worktree: config.worktree,
    timeouts: config.timeouts,
    sandbox: config.sandbox,
    verify: verify?.status === "resolved" ? verify.value : null,
  });
}

/** The run profile a run started with (its stored `run_profile_id`), or null. */
export function runProfileOf(office: OfficeHandle, runProfileId: string | null): RunProfile | null {
  if (runProfileId === null) return null;
  const id = Number(runProfileId);
  return Number.isInteger(id) ? (storedProfile(office, id)?.profile ?? null) : null;
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

// ---- the base in the box (DIPO-294) -------------------------------------------------------------

/**
 * The format of the in-box key; a change to what the in-box base verify does bumps it. 2: the
 * install runs in the box first, and a red result without a named failing test is not stored.
 */
export const BOX_BASE_VERIFY_FORMAT = 2;

/** The configuration an in-box result depends on: the run environment and the deadlines. */
export type BoxBaseVerifyConfig = Pick<OfficeConfig, "worktree" | "timeouts">;

/** What the box holds besides the start commit: its image and the listed box files. */
export interface BoxBaseKey {
  /** `dipo-box:<sha256 of the build file>`. */
  readonly image: string;
  /** The paths of the listed box files copied in from the main checkout, sorted. */
  readonly files: readonly string[];
}

/**
 * The configuration hash an in-box result is keyed by, beside the start commit: the box image
 * and listed files, the install and verify commands of the run profile, the run environment's
 * settings and the deadlines. It never equals a Mac hash (`baseVerifyConfigHash`), so the two
 * results share `base_verifies` without meeting. A later package cache (DIPO-295) changes what
 * the install does and must change this key too, by its own input or the format.
 */
export function boxBaseVerifyConfigHash(
  config: BoxBaseVerifyConfig,
  profile: RunProfile | null,
  box: BoxBaseKey,
): string {
  const resolved = (name: "install" | "verify") => {
    const capability = profile?.capabilities[name];
    return capability?.status === "resolved" ? capability.value : null;
  };
  return configHash({
    box: BOX_BASE_VERIFY_FORMAT,
    image: box.image,
    files: [...box.files].toSorted(),
    worktree: config.worktree,
    timeouts: config.timeouts,
    devPorts: profile?.devPorts ?? [],
    install: resolved("install"),
    verify: resolved("verify"),
  });
}

const NO_BOX_RESULT: BaseVerifyFacts = {
  kind: "unknown",
  reason: "dipo has no verify result of the start commit in this box",
};

/** The in-box result of a start commit, or the not-known facts that say there is none. */
export function boxBaseVerifyFactsOf(
  office: OfficeHandle,
  input: {
    readonly startSha: string | null;
    readonly box: BoxBaseKey | null;
    readonly config: BoxBaseVerifyConfig;
    readonly profile: RunProfile | null;
  },
): BaseVerifyFacts {
  if (input.startSha === null || input.box === null) return NO_BOX_RESULT;
  const hash = boxBaseVerifyConfigHash(input.config, input.profile, input.box);
  const stored = findBaseVerify(office, input.startSha, hash);
  // A red result without a named test is never one dipo stores; an older row is not trusted.
  if (stored === null || (stored.kind === "red" && stored.failing.length === 0)) {
    return NO_BOX_RESULT;
  }
  return stored;
}

/**
 * The in-box result of `startSha`: the stored one for the key, else `run` once (verify in the
 * box), stored when it ran to the end and, when red, named its failing tests. A not-known result
 * and a red one without a named test are not stored (the latter becomes not known), so a broken
 * box is never cached and the next run tries again. `reused` says no verify ran.
 */
export async function boxBaseVerifyOf(input: {
  readonly office: OfficeHandle;
  readonly startSha: string;
  readonly box: BoxBaseKey;
  readonly config: BoxBaseVerifyConfig;
  readonly profile: RunProfile | null;
  readonly runId: string;
  readonly now: () => number;
  readonly run: () => Promise<BaseVerifyFacts>;
}): Promise<{ readonly facts: BaseVerifyFacts; readonly reused: boolean }> {
  const stored = boxBaseVerifyFactsOf(input.office, input);
  if (stored.kind !== "unknown") return { facts: stored, reused: true };
  const ran = await input.run();
  const facts: BaseVerifyFacts =
    ran.kind === "red" && ran.failing.length === 0
      ? {
          kind: "unknown",
          reason: "verify failed at the start commit in the box without a failing test name",
        }
      : ran;
  if (facts.kind !== "unknown") {
    input.office.immediate(() =>
      storeBaseVerify(input.office, {
        baseSha: input.startSha,
        hash: boxBaseVerifyConfigHash(input.config, input.profile, input.box),
        runId: input.runId,
        result: facts,
        at: input.now(),
      }),
    );
  }
  return { facts, reused: false };
}
