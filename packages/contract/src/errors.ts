// Errors of 0005 section 10. Codes are part of the contract; messages are not.

import { z } from "zod";

import { Cursor } from "./ids";
import { ContractVersion } from "./version";

export const EngineError = z.object({
  code: z.string(), // open set, dotted: "story.notRunning", "args.invalid", ...
  message: z.string(), // one sentence for people
  retryable: z.boolean(), // true only when the same request may succeed later
  details: z.unknown().optional(),
});
export type EngineError = z.infer<typeof EngineError>;

// Generic codes any command or read may return.
export const GENERIC_ERROR_CODES = [
  "contract.unsupported",
  "args.invalid",
  "office.unknown",
  "story.unknown",
  "story.ambiguous",
  "capability.missing",
  "request.reused",
  "confirmation.required",
  "not.permitted",
  "auth.failed",
  "stream.resetRequired",
  "internal",
] as const;

// The only codes for which the same request may succeed later.
export const RETRYABLE_ERROR_CODES = [
  "engine.recovering",
  "scheduling.off",
  "run.hostAlive",
  // Since minor 1 (DIPO-48; 0005 amendment of 2026-10-13): fetching the base failed, for example
  // offline; `work.run` waits until a fetch succeeds.
  "git.fetchFailed",
] as const;

// Specific codes of the software-level commands (0005 section 4). Since minor 1 (DIPO-27):
// `office.refused` for an office whose engine instance would not load (its `office.json` names
// another id, or a load step failed; `details` name the step), also on office-level commands and
// reads, and `office.markerInvalid` for an `office.json` that is not a valid marker.
export const SOFTWARE_ERROR_CODES = [
  "office.notProject",
  "office.pathMissing",
  "office.busy",
  "office.refused",
  "office.markerInvalid",
  "scan.running",
  "daemon.notSafe",
] as const;

// Specific codes of office-level commands and reads. Since minor 1 (DIPO-71): `config.invalid`
// when the office has no valid configuration, so the command or read cannot run, and
// `backlog.unreadable` when the Backlog CLI could not read the story or the backlog on the office's
// base branch. Since minor 1 (DIPO-48): `run.refused` when an office check refuses `work.run`;
// `details.check` names it (`adapter`, `statuses` or `verify`; `plan-limit` since DIPO-61).
// Since minor 1 (DIPO-59): `question.closed` when `work.answer` names a question that is not waiting.
export const OFFICE_ERROR_CODES = [
  "config.invalid",
  "backlog.unreadable",
  "run.refused",
  "question.closed",
] as const;

export type GenericErrorCode = (typeof GENERIC_ERROR_CODES)[number];
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];
export type SoftwareErrorCode = (typeof SOFTWARE_ERROR_CODES)[number];
export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number];
export type KnownErrorCode =
  | GenericErrorCode
  | RetryableErrorCode
  | SoftwareErrorCode
  | OfficeErrorCode;

export function isRetryableErrorCode(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

// Builds an error whose `retryable` follows the code, so no caller can get it wrong.
export function engineError(code: string, message: string, details?: unknown): EngineError {
  const error: EngineError = { code, message, retryable: isRetryableErrorCode(code) };
  if (details !== undefined) error.details = details;
  return error;
}

// `details` of `contract.unsupported`: the daemon's contract and version (frozen, section 11).
export const ContractUnsupportedDetails = z.object({
  contract: ContractVersion,
  version: z.string(),
});
export type ContractUnsupportedDetails = z.infer<typeof ContractUnsupportedDetails>;

// `details` of `stream.resetRequired`: the oldest cursor the stream can still replay from.
export const StreamResetRequiredDetails = z.object({ oldest: Cursor });
export type StreamResetRequiredDetails = z.infer<typeof StreamResetRequiredDetails>;
