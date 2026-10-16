// Asserts that lint keeps the Claude CLI adapter out of `packages/engine/src/hooks/` (0008 amendment
// of 2026-10-12, DIPO-59 AC #3): hook payloads and replies are Claude-specific and stay in the
// adapter, while the adapter imports its own modules (the wider seam is lint-engine-seams.test.ts,
// DIPO-113).

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const IMPORTS = "eslint(no-restricted-imports)";
const HOOKS = "packages/engine/src/hooks";

describe("oxlint hooks boundary", () => {
  it(
    "reports a workers/claude-cli import in hooks/ and allows the adapter its own modules",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "hooks-imports-claude-cli.ts", target: `${HOOKS}/leak.ts` },
        { fixture: "hooks-allowed.ts", target: `${HOOKS}/allowed.ts` },
        {
          fixture: "claude-cli-internal.ts",
          target: "packages/engine/src/workers/claude-cli/internal.ts",
        },
      ]);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter((d) => d.code === IMPORTS && d.severity === "error");
      expect(hits.map((d) => d.filename)).toEqual([`${HOOKS}/leak.ts`]);
      expect(diagnostics.filter((d) => d.filename !== `${HOOKS}/leak.ts`)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
