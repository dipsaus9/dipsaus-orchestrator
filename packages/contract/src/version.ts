// Contract version of 0005 section 11, independent of the binary version. Same major means
// compatible; a minor adds only.

import { z } from "zod";

export const ContractVersion = z.object({
  major: z.int().nonnegative(),
  minor: z.int().nonnegative(),
});
export type ContractVersion = z.infer<typeof ContractVersion>;

// Minor 1 (DIPO-27): `office.reloadConfig` ships and `office.open` replies with `warnings`.
// Also in minor 1 (DIPO-72): `scan.finished` carries `trigger`, `level`, `deviations`, `diff` and
// `error`.
// DIPO-65 adds the read `office.stats` to the same, still unreleased, minor.
// DIPO-71 adds the read `story.gate` and the error codes `config.invalid` and `backlog.unreadable`
// to the same, still unreleased, minor.
// DIPO-36 ships the command `office.init` in the same, still unreleased, minor.
// DIPO-48 adds the optional `from` of `work.run`, the retryable `git.fetchFailed` and the office
// code `run.refused` to the same, still unreleased, minor.
// DIPO-74 adds the read `work.preview` (the dry run of `work.run`) to the same, still unreleased,
// minor.
// DIPO-52 adds the read `office.switch`, the optional `view` (a `WorkView`) on the work events and
// `usage.updated`, `work.observed.clearedAt`, and `Verdict.failures` with `Verdict.run` optional
// to the same, still unreleased, minor.
// DIPO-59 ships `work.answer` (with `decision` for permission questions), `question.asked` and
// `question.closed`, adds the optional `questions` of `story.detail` and the office code
// `question.closed` to the same, still unreleased, minor.
// DIPO-61 ships the command `work.resume` (for runs held by a plan limit) in the same, still
// unreleased, minor.
// DIPO-76 ships the command `office.purge` in the same, still unreleased, minor.
// DIPO-83 adds the optional `optIns` of `OfficeSummary` (the privacy opt-ins that are on) to the
// same, still unreleased, minor.
export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 1 }) satisfies ContractVersion;
