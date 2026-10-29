// Asserts the daemon's one door into the engine (0004, 0005; DIPO-318 AC #2):
// `dipo/daemon-engine-imports` reports, in `packages/daemon/src`, every import of the engine entry
// but `createEngine` and types (a value, a namespace, a default, a value re-export, `export *`,
// `import x = require`, a dynamic import, `require`), and lets the platform entry, type-only
// imports and `typeof import(...)` pass. The daemon's tests and the engine itself are not its
// concern.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const RULE = "dipo(daemon-engine-imports)";
const DAEMON = "packages/daemon/src";

/** One diagnostic per form in `daemon-engine-values.ts`. */
const FORMS = 8;

describe("the daemon's imports of the engine", () => {
  it(
    "reports every value import of the engine entry but createEngine",
    () => {
      const { exitCode, diagnostics } = lintTree([
        { fixture: "daemon-engine-values.ts", target: `${DAEMON}/leak.ts` },
      ]);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter(
        (d) => d.code === RULE && d.severity === "error" && d.filename === `${DAEMON}/leak.ts`,
      );
      expect(hits.length).toBe(FORMS);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows createEngine, types and the platform entry, and leaves the daemon's tests alone",
    () => {
      const { diagnostics } = lintTree([
        { fixture: "daemon-engine-allowed.ts", target: `${DAEMON}/ok.ts` },
        { fixture: "daemon-engine-values.ts", target: "packages/daemon/test/support/fixture.ts" },
      ]);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
      expect(diagnostics.filter((d) => d.filename === `${DAEMON}/ok.ts`)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
