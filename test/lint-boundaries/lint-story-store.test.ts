// Asserts that lint keeps the engine behind the StoryStore seam (0010; DIPO-356 AC #3):
// `dipo/no-backlog-import` reports an import of `packages/engine/src/backlog` from any other engine
// file, in every form (static, type-only, re-export, `export *`, `import()`, `require` and
// `typeof import(...)`), by a relative path at any depth or by a deep package path. The Backlog.md
// implementation itself, the composition root (the engine entry and its feature list), tests, and a
// module that is only named `backlog` may import it.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const RULE = "dipo(no-backlog-import)";
const DEEP = "eslint(no-restricted-imports)";
const ENGINE = "packages/engine/src";

/** `rules` lists one entry per expected diagnostic; a rule may repeat. */
type Case = { fixture: string; target: string; rules: string[] };

const violations: Case[] = [
  {
    fixture: "backlog-import.ts",
    target: `${ENGINE}/run/stories.ts`,
    rules: [RULE, RULE, RULE, RULE, RULE, RULE, RULE],
  },
  {
    fixture: "backlog-import.ts",
    target: `${ENGINE}/story-store/leak.ts`,
    rules: Array(7).fill(RULE),
  },
  {
    fixture: "backlog-import-nested.ts",
    target: `${ENGINE}/gate/store/leak.ts`,
    rules: [RULE, RULE, DEEP],
  },
];

const allowed: Omit<Case, "rules">[] = [
  { fixture: "backlog-import.ts", target: `${ENGINE}/backlog/lane/inside.ts` },
  { fixture: "backlog-import-nested.ts", target: `${ENGINE}/backlog/lane/inside-nested.ts` },
  { fixture: "entry-imports-backlog.ts", target: `${ENGINE}/index.ts` },
  { fixture: "entry-imports-backlog.ts", target: `${ENGINE}/features.ts` },
  { fixture: "story-store-import.ts", target: `${ENGINE}/merge/merger.ts` },
  { fixture: "backlog-import.ts", target: "packages/engine/test/run/uses-backlog.test.ts" },
];

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(violations);
  return violationRun;
}

describe("oxlint StoryStore seam", () => {
  for (const c of violations) {
    for (const rule of new Set(c.rules)) {
      const count = c.rules.filter((r) => r === rule).length;
      it(
        `reports ${c.fixture} at ${c.target} with ${rule} (${count}x)`,
        () => {
          const { exitCode, diagnostics } = lintViolations();
          expect(exitCode).not.toBe(0);
          const hits = diagnostics.filter(
            (d) => d.code === rule && d.severity === "error" && d.filename === c.target,
          );
          expect(hits.length).toBe(count);
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
    "allows the implementation, the composition root, tests and a module named backlog",
    () => {
      const { diagnostics } = lintTree(allowed);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
