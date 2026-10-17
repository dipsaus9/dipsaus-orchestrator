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
