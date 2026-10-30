// The "since you left" line of the overview (0009 sections 4 and 8, DIPO-308): `office.digest`
// without `since` counts from when the office's last TUI client disconnected, as the engine
// stored it. The TUI reads it once per office it opens and shows
// the engine's non-zero counts in the engine's order; it counts nothing itself.

import type { EngineError, OfficeId } from "@dipsaus-orchestrator/contract";
import { useEffect, useState } from "react";

import { clockTime } from "./views";

export interface DigestResult {
  readonly since: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly lines: readonly string[];
}

export type DigestOutcome =
  | { readonly ok: true; readonly result: DigestResult }
  | { readonly ok: false; readonly error: EngineError };

export type ReadDigest = (office: OfficeId) => Promise<DigestOutcome>;

/** How a count reads, singular and plural; a count the TUI does not know shows as its name. */
const COUNT_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  done: ["done", "done"],
  parked: ["parked", "parked"],
  held: ["held", "held"],
  questions: ["question", "questions"],
  merges: ["merge waits on you", "merges wait on you"],
  proposals: ["proposal", "proposals"],
};

/** `since you left (09:12): 2 done · 1 parked`, or `… nothing changed`. */
export function digestLine(digest: DigestResult, dot: string): string {
  const parts = Object.entries(digest.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => {
      const words = COUNT_WORDS[name];
      return `${count} ${words === undefined ? name : words[count === 1 ? 0 : 1]}`;
    });
  const since = `since you left (${clockTime(Date.parse(digest.since))})`;
  return `${since}: ${parts.length === 0 ? "nothing changed" : parts.join(` ${dot} `)}`;
}

/** The digest of the open office, read once when it opens; null without one. */
export function useDigest(options: {
  readonly office: OfficeId | null;
  readonly readDigest: ReadDigest;
}): DigestResult | null {
  const { office, readDigest } = options;
  const [digest, setDigest] = useState<{ office: OfficeId; result: DigestResult } | null>(null);
  useEffect(() => {
    if (office === null) return;
    let current = true;
    void readDigest(office).then((outcome) => {
      if (current && outcome.ok) setDigest({ office, result: outcome.result });
    });
    return () => {
      current = false;
    };
  }, [office, readDigest]);
  return digest !== null && digest.office === office ? digest.result : null;
}
