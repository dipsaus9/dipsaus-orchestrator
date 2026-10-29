// Runs the repository's oxlint config over fixture files placed inside a scratch copy of the
// package layout, and asserts that every boundary rule of decision 0004 is reported as an error.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Placement } from "./lint-tree";

const RULE = "dipo(package-imports)";

const violations: Placement[] = [
  { fixture: "tui-imports-engine.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "tui-imports-daemon.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "tui-imports-cli.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "tui-imports-testkit.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "client-imports-engine.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "client-imports-daemon.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "cli-imports-engine.ts", target: "packages/cli/src/fixture.ts" },
  // The deep-import ban holds in every package, including the ones with their own override.
  { fixture: "deep-import.ts", target: "packages/engine/src/run/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/cli/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/daemon/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/testkit/src/fixture.ts" },
];

describe("oxlint import boundaries", () => {
  for (const placement of violations) {
    it(
      `reports ${placement.fixture} in ${placement.target}`,
      () => {
        const { exitCode, diagnostics } = lintTree([placement]);
        expect(exitCode).not.toBe(0);
        const hits = diagnostics.filter(
          (d) => d.code === RULE && d.severity === "error" && d.filename === placement.target,
        );
        expect(hits.length).toBeGreaterThan(0);
      },
      LINT_TIMEOUT_MS,
    );
  }

  it(
    "allows cli to import client, contract and daemon",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "cli-allowed.ts", target: "packages/cli/src/fixture.ts" },
      ]);
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows tui to import contract, client and client/node",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "tui-allowed.ts", target: "packages/tui/src/fixture.ts" },
      ]);
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
