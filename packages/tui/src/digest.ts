// The "since you left" line of the overview (0009): the TUI keeps, in memory, the time it last saw
// each office (when it switched away from it) and sends it as `since` each time it opens the
// office; an office it has not shown yet in this run counts from the time it opens, so nothing
// shows. The engine keeps no such time (0001). The TUI shows the engine's non-zero counts in the
// engine's order; it counts nothing itself.

import type { Clock, EngineError, OfficeId } from "@dipsaus-orchestrator/contract";
import { useEffect, useRef, useState } from "react";

import { clockTime } from "./views";

export interface DigestResult {
  readonly since: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly lines: readonly string[];
}

export type DigestOutcome =
  | { readonly ok: true; readonly result: DigestResult }
  | { readonly ok: false; readonly error: EngineError };

/** `office.digest` for `office` from `since` (an ISO time). */
export type ReadDigest = (office: OfficeId, since: string) => Promise<DigestOutcome>;

/** How a count reads, singular and plural; a count the TUI does not know shows as its name. */
const COUNT_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  done: ["done", "done"],
  parked: ["parked", "parked"],
  parkedByYou: ["parked by you", "parked by you"],
  questions: ["question", "questions"],
  merges: ["merge waits on you", "merges wait on you"],
  proposals: ["proposed story", "proposed stories"],
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

/**
 * The digest of the open office, read once when it opens, from the time this TUI last switched
 * away from it; null without one.
 */
export function useDigest(options: {
  readonly office: OfficeId | null;
  readonly readDigest: ReadDigest;
  readonly clock: Clock;
}): DigestResult | null {
  const { office, readDigest, clock } = options;
  const [digest, setDigest] = useState<{ office: OfficeId; result: DigestResult } | null>(null);
  /** When this TUI last stopped showing each office, in ms. */
  const lastSeen = useRef(new Map<OfficeId, number>());
  useEffect(() => {
    if (office === null) return;
    let current = true;
    const since = lastSeen.current.get(office) ?? clock.now();
    void readDigest(office, new Date(since).toISOString()).then((outcome) => {
      if (current && outcome.ok) setDigest({ office, result: outcome.result });
    });
    return () => {
      current = false;
      lastSeen.current.set(office, clock.now());
    };
  }, [office, readDigest, clock]);
  return digest !== null && digest.office === office ? digest.result : null;
}
