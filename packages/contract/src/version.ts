// Contract version of 0005 section 11, independent of the binary version. Same major means
// compatible; a minor adds only.

import { z } from "zod";

export const ContractVersion = z.object({
  major: z.int().nonnegative(),
  minor: z.int().nonnegative(),
});
export type ContractVersion = z.infer<typeof ContractVersion>;

// Minor 1 (DIPO-27): `office.reloadConfig` ships and `office.open` replies with `warnings`.
// Also in minor 1 (DIPO-72): `office.rescan` is built and `scan.finished` carries `trigger`,
// `level`, `diff` and `error`.
export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 1 }) satisfies ContractVersion;
