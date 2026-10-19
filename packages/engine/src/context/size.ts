// Size classes and the context and inputs budgets (0014 section 4). The class comes from the
// `git ls-files` count at pickup, in code. Budgets are characters; they are tunable starting
// defaults, which `prompt.budgets` in `office.yaml` may override later.

import type { SizeClass, Workspace } from "./types";

/** Upper bounds (exclusive) of S, M and L; XL is everything above. */
export const SIZE_CLASS_LIMITS = { S: 150, M: 500, L: 5000 } as const;

/** S under 150 files, M under 500, L under 5,000, XL above. */
export function sizeClassOf(fileCount: number): SizeClass {
  if (fileCount < SIZE_CLASS_LIMITS.S) return "S";
  if (fileCount < SIZE_CLASS_LIMITS.M) return "M";
  if (fileCount < SIZE_CLASS_LIMITS.L) return "L";
  return "XL";
}

/** The size class of a checkout from its tracked file count. */
export async function sizeClassOfWorkspace(ws: Workspace): Promise<SizeClass> {
  return sizeClassOf((await ws.trackedFiles()).length);
}

/** `context` pack budget per size class. */
export const CONTEXT_BUDGETS: Readonly<Record<SizeClass, number>> = {
  S: 12_000,
  M: 18_000,
  L: 24_000,
  XL: 32_000,
};

/** `inputs` content budget per size class; the path list is never cut. */
export const INPUTS_BUDGETS: Readonly<Record<SizeClass, number>> = {
  S: 8_000,
  M: 12_000,
  L: 16_000,
  XL: 20_000,
};

/** At most this many characters per context item. */
export const CONTEXT_ITEM_MAX = 4_000;

/** At most this many characters per pre-fetched input file. */
export const INPUT_FILE_MAX = 4_000;

/** A directory input pre-fetches at most this many files. */
export const DIRECTORY_ENTRIES_MAX = 200;

/** A scope directory lists at most this many files, the ones changed most recently on the base. */
export const DIRECTORY_RECENT_MAX = 15;

/** A component lists at most this many of its files. */
export const COMPONENT_FILES_MAX = 50;
