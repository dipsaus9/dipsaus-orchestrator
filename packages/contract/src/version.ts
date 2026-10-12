// Contract version of 0005 section 11, independent of the binary version. Same major means
// compatible; a minor adds only.

import { z } from "zod";

export const ContractVersion = z.object({
  major: z.int().nonnegative(),
  minor: z.int().nonnegative(),
});
export type ContractVersion = z.infer<typeof ContractVersion>;

export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 0 }) satisfies ContractVersion;
