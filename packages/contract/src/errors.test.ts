import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GENERIC_ERROR_CODES, RETRYABLE_ERROR_CODES } from "./errors";

const ADR = readFileSync(
  join(import.meta.dir, "..", "..", "..", "docs", "decisions", "0005-command-and-event-model.md"),
  "utf8",
);

// The backticked codes of the sentence that opens with `lead`; the list ends at the first ". ".
function codesAfter(lead: string): string[] {
  const match = ADR.match(new RegExp(`${lead} (.*?)\\. `, "s"));
  if (!match?.[1]) throw new Error(`0005 has no sentence that starts "${lead}"`);
  return [...match[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

describe("0005 error codes", () => {
  it("lists the generic codes exactly as errors.ts does", () => {
    expect(codesAfter("The generic codes are").toSorted()).toEqual(
      ([...GENERIC_ERROR_CODES] as string[]).toSorted(),
    );
  });

  it("lists the retryable codes exactly as errors.ts does", () => {
    expect(codesAfter("The retryable codes are").toSorted()).toEqual(
      ([...RETRYABLE_ERROR_CODES] as string[]).toSorted(),
    );
  });
});
