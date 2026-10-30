// Asserts that lint keeps budget, gate, git and database code out of the worker host
// (0006 decision 8, DIPO-44 AC #5): `packages/engine/src/host/` may not import them, while the
// same imports elsewhere in the engine stay allowed.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const IMPORTS = "eslint(no-restricted-imports)";
const HOST = "packages/engine/src/host";

const banned = [
  "host-imports-db.ts",
  "host-imports-sqlite.ts",
  "host-imports-git.ts",
  "host-imports-gate.ts",
  "host-imports-gate-decisions.ts",
  "host-imports-budget.ts",
  "host-imports-records.ts",
];

let run: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintBanned() {
  run ??= lintTree(banned.map((fixture) => ({ fixture, target: `${HOST}/${fixture}` })));
  return run;
}

describe("oxlint worker host boundary", () => {
  for (const fixture of banned) {
    it(
      `reports ${fixture} in host/`,
      () => {
        const { exitCode, diagnostics } = lintBanned();
        expect(exitCode).not.toBe(0);
        const hits = diagnostics.filter(
          (d) =>
            d.code === IMPORTS && d.severity === "error" && d.filename === `${HOST}/${fixture}`,
        );
        expect(hits.length).toBeGreaterThan(0);
      },
      LINT_TIMEOUT_MS,
    );
  }

  it(
    "allows platform, logging and the worker contract in host/, and the banned modules elsewhere",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "host-allowed.ts", target: `${HOST}/host-allowed.ts` },
        { fixture: "host-imports-db.ts", target: "packages/engine/src/records/uses-db.ts" },
        { fixture: "host-imports-budget.ts", target: "packages/engine/src/records/uses-budget.ts" },
        {
          fixture: "host-imports-gate-decisions.ts",
          target: "packages/engine/src/run/uses-gate-decisions.ts",
        },
      ]);
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
