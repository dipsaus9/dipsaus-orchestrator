// Asserts that lint enforces the two engine seams (0004, 0008 section 1; DIPO-113 AC #2): only
// `packages/engine/src/workers/**` and the engine entry import `workers/claude-cli`, and only
// `packages/engine/src/platform/**` imports `bun` or `bun:sqlite`. Tests and `bun:test` stay free.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const CLAUDE_CLI = "dipo(no-claude-cli-import)";
const BUN = "dipo(no-bun-import)";
const ENGINE = "packages/engine/src";

type Case = { fixture: string; target: string; rule: string };

const violations: Case[] = [
  { fixture: "engine-imports-claude-cli.ts", target: `${ENGINE}/run/leak.ts`, rule: CLAUDE_CLI },
  {
    fixture: "engine-imports-claude-cli.ts",
    target: `${ENGINE}/worktree/leak.ts`,
    rule: CLAUDE_CLI,
  },
  { fixture: "engine-imports-bun.ts", target: `${ENGINE}/run/bun.ts`, rule: BUN },
  { fixture: "engine-imports-sqlite.ts", target: `${ENGINE}/db/sqlite.ts`, rule: BUN },
  { fixture: "engine-loads-bun.ts", target: `${ENGINE}/runs/load.ts`, rule: BUN },
];

const allowed: Omit<Case, "rule">[] = [
  { fixture: "engine-imports-claude-cli.ts", target: `${ENGINE}/workers/uses-adapter.ts` },
  { fixture: "entry-exports-claude-cli.ts", target: `${ENGINE}/index.ts` },
  { fixture: "engine-imports-claude-cli.ts", target: "packages/engine/test/run/uses-adapter.ts" },
  { fixture: "engine-imports-bun.ts", target: `${ENGINE}/platform/bun.ts` },
  { fixture: "engine-imports-sqlite.ts", target: `${ENGINE}/platform/sqlite.ts` },
  { fixture: "engine-loads-bun.ts", target: `${ENGINE}/platform/load.ts` },
  { fixture: "engine-imports-bun-test.ts", target: `${ENGINE}/run/run.test.ts` },
];

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(violations);
  return violationRun;
}

describe("oxlint engine seams", () => {
  for (const c of violations) {
    it(
      `reports ${c.fixture} at ${c.target} with ${c.rule}`,
      () => {
        const { exitCode, diagnostics } = lintViolations();
        expect(exitCode).not.toBe(0);
        const hits = diagnostics.filter(
          (d) => d.code === c.rule && d.severity === "error" && d.filename === c.target,
        );
        expect(hits.length).toBe(1);
      },
      LINT_TIMEOUT_MS,
    );
  }

  it(
    "reports nothing else for the violations",
    () => {
      const { diagnostics } = lintViolations();
      const expected = new Set(violations.map((c) => `${c.rule} ${c.target}`));
      expect(diagnostics.filter((d) => !expected.has(`${d.code} ${d.filename}`))).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows the adapter in workers/, the engine entry and tests, Bun in platform/, and bun:test",
    () => {
      const { exitCode, diagnostics } = lintTree(allowed);
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
