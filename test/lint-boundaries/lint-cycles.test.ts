// Asserts that lint fails a runtime import cycle (DIPO-113 AC #1): `import/no-cycle` with
// `ignoreTypes`, so a cycle through `import type` only, which is erased at runtime, stays allowed.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const CYCLE = "import(no-cycle)";
const RUN = "packages/engine/src/run";

describe("oxlint import cycles", () => {
  it(
    "reports a runtime cycle and allows a type-only one",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "cycle-a.ts", target: `${RUN}/cycle-a.ts` },
        { fixture: "cycle-b.ts", target: `${RUN}/cycle-b.ts` },
        { fixture: "type-cycle-a.ts", target: `${RUN}/type-cycle-a.ts` },
        { fixture: "type-cycle-b.ts", target: `${RUN}/type-cycle-b.ts` },
      ]);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter((d) => d.code === CYCLE && d.severity === "error");
      expect(hits.map((d) => d.filename).toSorted()).toEqual([
        `${RUN}/cycle-a.ts`,
        `${RUN}/cycle-b.ts`,
      ]);
      expect(diagnostics.filter((d) => d.code !== CYCLE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
