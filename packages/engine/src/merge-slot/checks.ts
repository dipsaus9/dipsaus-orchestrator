// The required checks a PR waits for in the merge slot (0016 rule 2): the office's
// `mergeSlot.requiredChecks` (default `ci-ok` and `pr-title`), and every other check the base
// requires. Pure code over what the host reports.

import { OFFICE_DEFAULTS } from "../config";
import type { RequiredCheck } from "../platform/host";

/**
 * The checks every PR waits for in the merge slot when the office sets none (0016 rule 2): the
 * default of `mergeSlot.requiredChecks` (DIPO-133).
 */
export const REQUIRED_CHECKS: readonly string[] = OFFICE_DEFAULTS.mergeSlot.requiredChecks;

export type ChecksVerdict =
  | { readonly state: "passed" }
  | { readonly state: "pending"; readonly waiting: readonly string[] }
  | { readonly state: "failed"; readonly failed: readonly string[] };

/**
 * `passed` when each of `names` is reported and passed and no other required check failed;
 * `failed` when any reported check failed or was cancelled; else `pending`, naming what it waits
 * for (a check the host has not reported yet counts as pending).
 */
export function evaluateChecks(
  checks: readonly RequiredCheck[],
  names: readonly string[] = REQUIRED_CHECKS,
): ChecksVerdict {
  const failed = checks
    .filter((check) => check.bucket === "fail" || check.bucket === "cancel")
    .map((check) => check.name);
  if (failed.length > 0) return { state: "failed", failed };
  const waiting = [
    ...names.filter(
      (name) => !checks.some((check) => check.name === name && check.bucket === "pass"),
    ),
    ...checks
      .filter((check) => check.bucket === "pending" && !names.includes(check.name))
      .map((check) => check.name),
  ];
  return waiting.length === 0 ? { state: "passed" } : { state: "pending", waiting };
}

/** One required check and its state as the story PR body shows it. */
export interface RequiredCheckState {
  readonly name: string;
  /** The host's bucket, or `pending` for a check it has not reported. */
  readonly state: string;
}

/**
 * Every required check of a head with its state (0019 sections 3 and 7): the office's `names`
 * first, then each other check the host reported as required. A check the host has not reported
 * is `pending`.
 */
export function requiredCheckStates(
  checks: readonly RequiredCheck[],
  names: readonly string[] = REQUIRED_CHECKS,
): RequiredCheckState[] {
  const state = (name: string): string =>
    checks.find((check) => check.name === name)?.bucket ?? "pending";
  return [...new Set([...names, ...checks.map((check) => check.name)])].map((name) => ({
    name,
    state: state(name),
  }));
}

/**
 * True when the required checks of a head are final: all passed, or at least one failed and none
 * is still pending or unreported (so one fix round carries every failure of the head, 0019
 * section 7).
 */
export function checksFinal(
  checks: readonly RequiredCheck[],
  names: readonly string[] = REQUIRED_CHECKS,
): boolean {
  const verdict = evaluateChecks(checks, names);
  if (verdict.state === "passed") return true;
  return (
    verdict.state === "failed" &&
    requiredCheckStates(checks, names).every(({ state }) => state !== "pending")
  );
}
