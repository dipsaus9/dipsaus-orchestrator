// Asserts that the main entry of `packages/client` stays runtime-free (0004 amendment of
// 2026-10-12): a `node:` import, a `bun` import and a Bun global are each reported there, and the
// same code is allowed in `client/node`, the only client code that may use Bun APIs. Engine and
// daemon stay banned in `client/node` too. One oxlint run per group keeps it fast; each fixture
// sits at its own path so every diagnostic is attributed to one placement.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const GLOBALS = "eslint(no-restricted-globals)";
const IMPORTS = "eslint(no-restricted-imports)";
const PROPERTIES = "eslint(no-restricted-properties)";

type Case = { fixture: string; dir: string; rule: string };

const violations: Case[] = [
  { fixture: "client-core-node-import.ts", dir: "packages/client/src", rule: IMPORTS },
  { fixture: "client-core-bun-import.ts", dir: "packages/client/src", rule: IMPORTS },
  { fixture: "client-core-bun-global.ts", dir: "packages/client/src", rule: GLOBALS },
  // Nested directories of the core are core too.
  { fixture: "client-core-node-import.ts", dir: "packages/client/src/core", rule: IMPORTS },
  { fixture: "client-core-bun-global.ts", dir: "packages/client/src/core", rule: GLOBALS },
  // The core keeps the timer ban; `client/node` keeps the engine and daemon bans.
  { fixture: "global-timer.ts", dir: "packages/client/src", rule: GLOBALS },
  { fixture: "global-timer.ts", dir: "packages/client/src/node", rule: GLOBALS },
  { fixture: "client-imports-engine.ts", dir: "packages/client/src", rule: IMPORTS },
  { fixture: "client-imports-engine.ts", dir: "packages/client/src/node", rule: IMPORTS },
  { fixture: "client-imports-daemon.ts", dir: "packages/client/src/node", rule: IMPORTS },
  // Property access through globalThis, self or window is banned like the bare global.
  { fixture: "client-core-global-this-bun.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "client-core-global-this-process.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "client-core-self-buffer.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "client-core-window-require.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "client-core-self-timer.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "client-core-window-timer.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "global-this-timer.ts", dir: "packages/client/src", rule: PROPERTIES },
  // The overrides keep the clock bans of the base config.
  { fixture: "date-now.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "date-now.ts", dir: "packages/client/src/node", rule: PROPERTIES },
  { fixture: "global-this-timer.ts", dir: "packages/client/src/node", rule: PROPERTIES },
];

const allowed: Omit<Case, "rule">[] = [
  { fixture: "client-core-global-this-bun.ts", dir: "packages/client/src/node" },
  { fixture: "client-core-global-this-process.ts", dir: "packages/client/src/node" },
  { fixture: "client-core-node-import.ts", dir: "packages/client/src/node" },
  { fixture: "client-core-bun-import.ts", dir: "packages/client/src/node" },
  { fixture: "client-core-bun-global.ts", dir: "packages/client/src/node" },
];

const target = (c: Omit<Case, "rule">, i: number) => `${c.dir}/case-${i}-${c.fixture}`;

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(
    violations.map((c, i) => ({ fixture: c.fixture, target: target(c, i) })),
  );
  return violationRun;
}

describe("oxlint runtime-free client core", () => {
  it(
    "fails lint when a violation is present",
    () => {
      expect(lintViolations().exitCode).not.toBe(0);
    },
    LINT_TIMEOUT_MS,
  );

  violations.forEach((c, i) => {
    it(
      `reports ${c.fixture} in ${c.dir} as ${c.rule}`,
      () => {
        const hits = lintViolations().diagnostics.filter(
          (d) => d.filename === target(c, i) && d.code === c.rule && d.severity === "error",
        );
        expect(hits.length).toBeGreaterThan(0);
      },
      LINT_TIMEOUT_MS,
    );
  });

  it(
    "allows Bun and Node APIs in client/node",
    () => {
      const { exitCode, diagnostics } = lintTree(
        allowed.map((c, i) => ({ fixture: c.fixture, target: target(c, i) })),
      );
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
