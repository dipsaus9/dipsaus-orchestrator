// Asserts that lint keeps the Claude CLI adapter out of `packages/engine/src/questions/` (0008 amendment
// of 2026-10-12, DIPO-59 AC #3): hook payloads and replies are Claude-specific and stay in the
// adapter, while the adapter imports its own modules (the wider seam is lint-engine-seams.test.ts,
// DIPO-113).

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const IMPORTS = "eslint(no-restricted-imports)";
const QUESTIONS = "packages/engine/src/questions";
/** The questions table moved to run-state/ (DIPO-392) and keeps the same boundary. */
const RUN_STATE_QUESTIONS = "packages/engine/src/run-state/questions.ts";

describe("oxlint questions boundary", () => {
  it(
    "reports a workers/claude-cli import in questions/ and allows the adapter its own modules",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "questions-imports-claude-cli.ts", target: `${QUESTIONS}/leak.ts` },
        { fixture: "questions-imports-claude-cli.ts", target: RUN_STATE_QUESTIONS },
        { fixture: "questions-allowed.ts", target: `${QUESTIONS}/allowed.ts` },
        {
          fixture: "claude-cli-internal.ts",
          target: "packages/engine/src/workers/claude-cli/internal.ts",
        },
      ]);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter((d) => d.code === IMPORTS && d.severity === "error");
      const leaks = [`${QUESTIONS}/leak.ts`, RUN_STATE_QUESTIONS];
      expect(hits.map((d) => d.filename).toSorted()).toEqual(leaks.toSorted());
      expect(diagnostics.filter((d) => !leaks.includes(d.filename))).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
