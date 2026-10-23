// The base commit's verify result (DIPO-183; 0014 section 2, note of 2026-10-20): reading bun's
// failing tests from an output and keying a stored result by the base commit's configuration.
// Setup no longer runs verify on the Mac (DIPO-240, 0021 amendment of 2026-10-22: CI is the verify
// of a box run), so no new result is stored; the stored ones a run still reads are keyed as here.

import { describe, expect, it } from "bun:test";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import type { RunProfile } from "../../src/scan/detect";
import { baseVerifyConfigHash, failingTests, outputEnd } from "../../src/worktree/base-verify";

const BUN_FAILURES = [
  "bun test v1.4.2",
  "\u001b[31m(fail)\u001b[0m sandbox > a worker may not read the home directory [1.20ms]",
  "(fail) worktree > setup copies the env file [0.40ms]",
  "",
  "2 fail",
  "(fail) sandbox > a worker may not read the home directory [1.20ms]",
  "(fail) worktree > setup copies the env file [0.40ms]",
].join("\n");

/** A run profile whose verify resolves to `commands`. */
function profileWith(commands: string[][]): RunProfile {
  return {
    capabilities: { verify: { status: "resolved", value: { commands, cwd: "." } } },
  } as unknown as RunProfile;
}

describe("failingTests", () => {
  it("reads bun's (fail) lines once each, without colour or timing", () => {
    expect(failingTests(BUN_FAILURES)).toEqual([
      "sandbox > a worker may not read the home directory",
      "worktree > setup copies the env file",
    ]);
  });

  it("finds nothing in the output of another runner", () => {
    expect(failingTests("FAIL src/a.test.ts\n  ✕ adds\n")).toEqual([]);
  });

  it("keeps the end of an output, without colour", () => {
    expect(outputEnd("\u001b[31mabcdef\u001b[0m\n\n", 3)).toBe("def");
  });
});

describe("the stored base verify result", () => {
  it("is keyed by the verify commands of the run profile too", () => {
    const verify = baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "run", "verify"]]));
    // The same commands give the same key; other commands, or none resolved, give another.
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "run", "verify"]]))).toBe(
      verify,
    );
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "test"]]))).not.toBe(verify);
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, null)).not.toBe(verify);
  });
});
