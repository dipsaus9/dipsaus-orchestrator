// Asserts that lint bans wall-clock time and global timers outside the platform module and
// testkit (0017 section 4), and synchronous process calls in engine and daemon code (0007
// section 1). All placements of one kind are linted in a single oxlint run to keep it fast;
// each fixture sits at its own path so every diagnostic is attributed to one placement.

import { describe, expect, it } from "bun:test";

import { lintTree, type Diagnostic } from "./lint-tree";

const GLOBALS = "eslint(no-restricted-globals)";
const PROPERTIES = "eslint(no-restricted-properties)";
const IMPORTS = "eslint(no-restricted-imports)";
const ARGLESS_DATE = "dipo(no-argless-date)";

type Case = { fixture: string; dir: string; rule: string };

const violations: Case[] = [
  // Time: banned everywhere outside packages/engine/src/platform/ and packages/testkit/.
  { fixture: "date-now.ts", dir: "packages/engine/src", rule: PROPERTIES },
  { fixture: "date-now.ts", dir: "packages/daemon/src", rule: PROPERTIES },
  { fixture: "date-now.ts", dir: "packages/client/src", rule: PROPERTIES },
  { fixture: "argless-date.ts", dir: "packages/engine/src", rule: ARGLESS_DATE },
  { fixture: "argless-date.ts", dir: "packages/tui/src", rule: ARGLESS_DATE },
  { fixture: "global-timer.ts", dir: "packages/engine/src", rule: GLOBALS },
  { fixture: "global-timer.ts", dir: "packages/cli/src", rule: GLOBALS },
  { fixture: "global-this-timer.ts", dir: "packages/daemon/src", rule: PROPERTIES },
  // Synchronous process calls: banned anywhere in engine/src (platform too) and daemon/src.
  { fixture: "bun-spawn-sync.ts", dir: "packages/daemon/src", rule: PROPERTIES },
  { fixture: "bun-spawn-sync.ts", dir: "packages/engine/src", rule: PROPERTIES },
  { fixture: "bun-spawn-sync.ts", dir: "packages/engine/src/platform", rule: PROPERTIES },
  { fixture: "node-exec-sync.ts", dir: "packages/daemon/src", rule: IMPORTS },
  { fixture: "node-exec-sync.ts", dir: "packages/engine/src/platform", rule: IMPORTS },
  { fixture: "namespace-spawn-sync.ts", dir: "packages/daemon/src", rule: PROPERTIES },
  // testkit never imports engine or daemon.
  { fixture: "testkit-imports-engine.ts", dir: "packages/testkit/src", rule: IMPORTS },
];

const allowed: Omit<Case, "rule">[] = [
  { fixture: "date-now.ts", dir: "packages/engine/src/platform" },
  { fixture: "argless-date.ts", dir: "packages/engine/src/platform" },
  { fixture: "global-timer.ts", dir: "packages/engine/src/platform" },
  { fixture: "global-this-timer.ts", dir: "packages/engine/src/platform" },
  { fixture: "date-now.ts", dir: "packages/testkit/src" },
  { fixture: "argless-date.ts", dir: "packages/testkit/src" },
  { fixture: "global-timer.ts", dir: "packages/testkit/src" },
  { fixture: "dated-date.ts", dir: "packages/engine/src" },
  // Outside engine and daemon a synchronous call is not banned by this rule.
  { fixture: "bun-spawn-sync.ts", dir: "packages/cli/src" },
];

const target = (c: Omit<Case, "rule">, i: number) => `${c.dir}/case-${i}-${c.fixture}`;

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(
    violations.map((c, i) => ({ fixture: c.fixture, target: target(c, i) })),
  );
  return violationRun;
}

describe("oxlint time and synchronous process bans", () => {
  violations.forEach((c, i) => {
    it(`reports ${c.fixture} in ${c.dir} with ${c.rule}`, () => {
      const { exitCode, diagnostics } = lintViolations();
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter(
        (d) => d.code === c.rule && d.severity === "error" && d.filename === target(c, i),
      );
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  it("allows the real clock in the platform module and testkit, and new Date(value)", () => {
    const { exitCode, diagnostics } = lintTree(
      allowed.map((c, i) => ({ fixture: c.fixture, target: target(c, i) })),
    );
    expect(diagnostics).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
