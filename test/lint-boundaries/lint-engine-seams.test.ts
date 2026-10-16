// Asserts that lint enforces the two engine seams (0004, 0008 section 1; DIPO-113 AC #2):
// - in `packages/engine/src`, only `workers/claude-cli/**` and the engine entry import
//   `workers/claude-cli`, type-only imports included;
// - in `packages/engine/src` and `packages/daemon/src`, only `engine/src/platform/**` imports `bun`
//   or a `bun:*` module other than `bun:test`, or uses the global `Bun` (tests may use the global).
// Every import form counts: static, re-export, `import()`, `require`, `import x = require(...)`,
// `typeof import(...)` and template literals without expressions.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const CLAUDE_CLI = "dipo(no-claude-cli-import)";
const BUN = "dipo(no-bun-import)";
const BUN_GLOBAL = "dipo(no-bun-global)";
const ENGINE = "packages/engine/src";
const DAEMON = "packages/daemon/src";

type Case = { fixture: string; target: string; rules: string[] };

const violations: Case[] = [
  { fixture: "engine-imports-claude-cli.ts", target: `${ENGINE}/run/leak.ts`, rules: [CLAUDE_CLI] },
  {
    fixture: "engine-imports-claude-cli.ts",
    target: `${ENGINE}/worktree/leak.ts`,
    rules: [CLAUDE_CLI],
  },
  {
    fixture: "port-imports-claude-cli.ts",
    target: `${ENGINE}/workers/port.ts`,
    rules: [CLAUDE_CLI],
  },
  { fixture: "engine-imports-bun.ts", target: `${ENGINE}/run/bun.ts`, rules: [BUN] },
  { fixture: "engine-imports-sqlite.ts", target: `${ENGINE}/db/sqlite.ts`, rules: [BUN] },
  { fixture: "engine-loads-bun.ts", target: `${ENGINE}/runs/load.ts`, rules: [BUN] },
  { fixture: "engine-imports-bun.ts", target: `${DAEMON}/bun.ts`, rules: [BUN] },
  { fixture: "bun-global.ts", target: `${ENGINE}/run/bun-global.ts`, rules: [BUN_GLOBAL] },
  { fixture: "bun-global.ts", target: `${DAEMON}/bun-global.ts`, rules: [BUN_GLOBAL] },
  { fixture: "import-equals.ts", target: `${ENGINE}/run/equals.ts`, rules: [BUN, CLAUDE_CLI] },
  { fixture: "import-type-query.ts", target: `${ENGINE}/run/types.ts`, rules: [BUN, CLAUDE_CLI] },
  { fixture: "import-template.ts", target: `${ENGINE}/run/template.ts`, rules: [BUN, CLAUDE_CLI] },
];

const allowed: Omit<Case, "rules">[] = [
  { fixture: "claude-cli-internal.ts", target: `${ENGINE}/workers/claude-cli/internal.ts` },
  { fixture: "entry-exports-claude-cli.ts", target: `${ENGINE}/index.ts` },
  { fixture: "engine-imports-claude-cli.ts", target: "packages/engine/test/run/uses-adapter.ts" },
  { fixture: "engine-imports-bun.ts", target: `${ENGINE}/platform/bun.ts` },
  { fixture: "engine-imports-sqlite.ts", target: `${ENGINE}/platform/sqlite.ts` },
  { fixture: "engine-loads-bun.ts", target: `${ENGINE}/platform/load.ts` },
  { fixture: "bun-global.ts", target: `${ENGINE}/platform/bun-global.ts` },
  { fixture: "bun-global-shadowed.ts", target: `${ENGINE}/run/shadowed.ts` },
  { fixture: "bun-global.ts", target: `${DAEMON}/spawn.test.ts` },
  { fixture: "engine-imports-bun-test.ts", target: `${ENGINE}/run/run.test.ts` },
];

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(violations);
  return violationRun;
}

describe("oxlint engine seams", () => {
  for (const c of violations) {
    for (const rule of c.rules) {
      it(
        `reports ${c.fixture} at ${c.target} with ${rule}`,
        () => {
          const { exitCode, diagnostics } = lintViolations();
          expect(exitCode).not.toBe(0);
          const hits = diagnostics.filter(
            (d) => d.code === rule && d.severity === "error" && d.filename === c.target,
          );
          expect(hits.length).toBe(1);
        },
        LINT_TIMEOUT_MS,
      );
    }
  }

  it(
    "reports nothing else for the violations",
    () => {
      const { diagnostics } = lintViolations();
      const expected = new Set(violations.flatMap((c) => c.rules.map((r) => `${r} ${c.target}`)));
      expect(diagnostics.filter((d) => !expected.has(`${d.code} ${d.filename}`))).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows the adapter inside itself, the engine entry and tests, Bun in platform/, a local Bun, the global in tests, and bun:test",
    () => {
      const { exitCode, diagnostics } = lintTree(allowed);
      expect(diagnostics).toEqual([]);
      expect(exitCode).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
