// The stdout scrub of the worker host (DIPO-105, 0007 section 8): the plan's `lineScrub` names the
// fields to remove from the typed objects of a stdout line, so a thinking text or signature never
// reaches `events.ndjson`. The host applies the rule as data and does not know what the types
// mean. A line the rule does not touch comes back byte for byte, so only changed lines are
// re-encoded.

import type { LineScrub } from "../workers/types";

/**
 * `line` (with its newline, when it has one) with the scrub's fields removed. A piece that is not
 * JSON, such as a part of a line longer than the splitter's cap, is returned as it is.
 */
export function scrubLine(line: string, scrub: LineScrub): string {
  const newline = line.endsWith("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(newline ? line.slice(0, -1) : line);
  } catch {
    return line;
  }
  if (!removeFields(parsed, scrub)) return line;
  return `${JSON.stringify(parsed)}${newline ? "\n" : ""}`;
}

/** Removes the scrub's fields from every typed object under `value`; true when one was removed. */
function removeFields(value: unknown, scrub: LineScrub): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  let removed = false;
  const type = record["type"];
  if (typeof type === "string" && scrub.blockTypes.includes(type)) {
    for (const field of scrub.fields) {
      if (field in record) {
        delete record[field];
        removed = true;
      }
    }
  }
  for (const child of Object.values(record)) {
    if (removeFields(child, scrub)) removed = true;
  }
  return removed;
}
