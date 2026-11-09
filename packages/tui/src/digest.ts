// "Since you last looked" (0009, DIPO-459): the TUI keeps, in memory, the time it last saw each
// office (when it switched away from it) and sends it as `since` each time it opens the office; an
// office it has not shown yet in this run counts from the time it opens, so nothing shows. The
// engine keeps no such time (0001). The Desk's Since band (`desk.tsx`) shows the engine's counts
// and spend; the TUI counts nothing itself.

import type { Clock, EngineError, OfficeId } from "@dipsaus-orchestrator/contract";
import { useEffect, useRef, useState } from "react";

export interface DigestResult {
  readonly since: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly lines: readonly string[];
  /** The estimated spend since `since`, in dollars; absent when no agent reported a cost. */
  readonly spent?: number | undefined;
}

export type DigestOutcome =
  | { readonly ok: true; readonly result: DigestResult }
  | { readonly ok: false; readonly error: EngineError };

/** `office.digest` for `office` from `since` (an ISO time). */
export type ReadDigest = (office: OfficeId, since: string) => Promise<DigestOutcome>;

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
