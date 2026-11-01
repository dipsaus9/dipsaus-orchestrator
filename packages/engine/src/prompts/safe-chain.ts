// What Safe-Chain found in a session (DIPO-376), as the worker's next turn and the reviewer read
// it: the refused packages and the logs that could not be read, each once. Moved from
// box/safe-chain.ts (DIPO-394) so the prompts import nothing from box/ (0004); box/safe-chain.ts
// reads the logs into these types and keeps a run's record of them.

export type SafeChainEcosystem = "npm" | "pypi";

/** One package Safe-Chain refused, as its log names it (DIPO-376). */
export interface SafeChainRefusal {
  readonly ecosystem: SafeChainEcosystem;
  /** `name@version` as Safe-Chain names it; the requested file's name when its log names none. */
  readonly package: string;
  /** Why Safe-Chain refused it. */
  readonly reason: string;
}

/** A log of a session that could not be read, so its refusals are unknown (DIPO-376). */
export interface SafeChainUnknown {
  readonly ecosystem: SafeChainEcosystem;
  readonly why: string;
}

/** What one read of a session's Safe-Chain logs found. */
export interface SafeChainFound {
  readonly refusals: readonly SafeChainRefusal[];
  readonly unknown: readonly SafeChainUnknown[];
  /** Refusals left out of `refusals` past `SAFE_CHAIN_RECORD_MAX`; none when absent. */
  readonly omitted?: number;
}

export const refusalKey = (refusal: SafeChainRefusal): string =>
  `${refusal.ecosystem} ${refusal.package}`;
export const unknownKey = (log: SafeChainUnknown): string => `${log.ecosystem} ${log.why}`;

/** Pure: `items` with each key once, first seen first. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Pure: `found` with each package refused once per ecosystem and each unknown log once (DIPO-376):
 * an install tried again is refused again, which says nothing new.
 */
export function uniqueFound(found: SafeChainFound): SafeChainFound {
  return {
    refusals: uniqueBy(found.refusals, refusalKey),
    unknown: uniqueBy(found.unknown, unknownKey),
    ...(found.omitted === undefined || found.omitted === 0 ? {} : { omitted: found.omitted }),
  };
}
