// Checks shared by the capture and the unit tests over committed recordings (0017 section 2).

import { isRecord } from "./format";
import type { Envelope } from "./format";
import { DECISION_FIELDS, isRedacted, messageKind, valuesAt } from "./scrub";

/** `kind.field` for every decision field that holds a redaction marker. */
export function decisionFieldProblems(lines: readonly Envelope[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    if (line.ch !== "stdout" || !isRecord(line.data)) continue;
    const kind = messageKind(line.data);
    const type = typeof line.data.type === "string" ? line.data.type : "";
    const fields = DECISION_FIELDS[kind] ?? (type === "system" ? undefined : DECISION_FIELDS[type]);
    for (const field of fields ?? []) {
      if (valuesAt(line.data, field).some(isRedacted)) {
        const problem = `${kind}.${field}`;
        if (!problems.includes(problem)) problems.push(problem);
      }
    }
  }
  return problems;
}
