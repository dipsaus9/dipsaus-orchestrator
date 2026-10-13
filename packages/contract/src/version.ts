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
export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 1 }) satisfies ContractVersion;
