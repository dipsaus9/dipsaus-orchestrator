// Asserts that lint refuses a `*.ci.test.ts` file whose tests register outside the DIPO_TEST_CI
// guard (0017 section 1, DIPO-316): such a file would run its CI-only tests in every local
// `bun test`. The accepted guard forms pass, and a plain `*.test.ts` file is not checked.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const GUARD = "dipo(ci-test-guard)";
const DIR = "packages/engine/test";

const UNGUARDED = `${DIR}/unguarded.ci.test.ts`;
const WRONG = `${DIR}/wrong-guard.ci.test.ts`;
const GUARDED = `${DIR}/guarded.ci.test.ts`;
const PLAIN = `${DIR}/plain.test.ts`;

describe("oxlint CI-only test guard", () => {
  it(
    "reports every unguarded registration and allows the guard forms",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "ci-test-unguarded.ts", target: UNGUARDED },
        { fixture: "ci-test-wrong-guard.ts", target: WRONG },
        { fixture: "ci-test-guarded.ts", target: GUARDED },
        { fixture: "ci-test-unguarded.ts", target: PLAIN },
      ]);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter((d) => d.code === GUARD && d.severity === "error");
      const count = (file: string) => hits.filter((d) => d.filename === file).length;
      // The top-level describe; the `it` inside it is checked through that describe.
      expect(count(UNGUARDED)).toBe(1);
      // Another variable, a truthy check and the else branch.
      expect(count(WRONG)).toBe(3);
      expect(count(GUARDED)).toBe(0);
      expect(count(PLAIN)).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
