// An engine output marker as one line of text (DIPO-60): the rule the TUI's output pane and
// `dipo watch` both print, so the two read the same.

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * An engine marker as a rule: `── 12:04:31 phase: verify ──` or `── 12:09:02 run ended: parked
 * ──` (local time; `--` in ASCII mode).
 */
export function markerRule(marker: OutputMarker, ascii = false): string {
  const at = new Date(marker.at);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  const rule = ascii ? "--" : "──";
  const label =
    marker.kind === "phase"
      ? `phase: ${marker.value}`
      : marker.kind === "ended"
        ? `run ended: ${marker.value}`
        : `${marker.kind}: ${marker.value}`;
  return `${rule} ${time} ${label} ${rule}`;
}
