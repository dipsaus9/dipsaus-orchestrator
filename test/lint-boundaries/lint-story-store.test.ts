// Asserts that lint keeps the engine behind the StoryStore seam (0010; DIPO-356 AC #3):
// `dipo/no-backlog-import` reports an import of `packages/engine/src/backlog` from any other engine
// file, in every form (static, type-only, re-export, `export *`, `import()`, `require`,
// `import x = require(...)` and `typeof import(...)`), by a relative path at any depth or by a deep
// package path. The Backlog.md implementation itself, the composition root (the engine entry, its
// feature list and the wiring files of createEngine), tests, and a module that is only named
// `backlog` may import it; no other
// engine file, also none of those that reached the planning lane or the task-file layout before
// DIPO-356 moved them behind the store (AC #2).

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const RULE = "dipo(no-backlog-import)";
const DEEP = "dipo(package-imports)";
const LAYERS = "dipo(engine-layers)";
const ENGINE = "packages/engine/src";

/** `rules` lists one entry per expected diagnostic; a rule may repeat. */
type Case = { fixture: string; target: string; rules: string[] };

/** Every import form of `backlog-import.ts` is one diagnostic. */
const FORMS = 8;

/** The forms of `backlog-import.ts` that load a value: all but the type-only import and `typeof import`. */
const VALUE_FORMS = 6;

/**
 * backlog/ is a higher engine layer than every directory below but create/ (0004), so there each
 * value form of `backlog-import.ts` also crosses up a layer.
 */
const UP = Array(VALUE_FORMS).fill(LAYERS);

/** The files that imported backlog/ before DIPO-356 moved them behind the store (AC #2). */
const FORMER_IMPORTERS = [
  "box/collisions.ts",
  "box/parts.ts",
  "merge/merger.ts",
  "records/park-state.ts",
  "run/conflicts.ts",
  "run/proposals.ts",
  "run/work-run.ts",
  "run/discard.ts",
  "run/planning.ts",
  "overview/desk.ts",
  "worktree/claim.ts",
];

const violations: Case[] = [
  {
    fixture: "backlog-import.ts",
    target: `${ENGINE}/run/stories.ts`,
    rules: [...Array(FORMS).fill(RULE), ...UP],
  },
  {
    fixture: "backlog-import.ts",
    target: `${ENGINE}/story-store/leak.ts`,
    rules: [...Array(FORMS).fill(RULE), ...UP],
  },
  // In create/, only the wiring files of createEngine are the composition root (DIPO-318).
  {
    fixture: "backlog-import.ts",
    target: `${ENGINE}/create/lifecycle.ts`,
    rules: Array(FORMS).fill(RULE),
  },
  ...FORMER_IMPORTERS.map((file) => ({
    fixture: "backlog-import.ts",
    target: `${ENGINE}/${file}`,
    rules: [...Array(FORMS).fill(RULE), ...UP],
  })),
  // Office init and the backlog PR merge now live in backlog/; their old places are engine code.
  {
    fixture: "backlog-import-nested.ts",
    target: `${ENGINE}/office/init/init.ts`,
    rules: [RULE, RULE, DEEP, LAYERS],
  },
  {
    fixture: "backlog-import-nested.ts",
    target: `${ENGINE}/scan/detect/leak.ts`,
    rules: [RULE, RULE, DEEP, LAYERS],
  },
];

const allowed: Omit<Case, "rules">[] = [
  { fixture: "backlog-import.ts", target: `${ENGINE}/backlog/lane/inside.ts` },
  { fixture: "backlog-import-nested.ts", target: `${ENGINE}/backlog/lane/inside-nested.ts` },
  { fixture: "entry-imports-backlog.ts", target: `${ENGINE}/index.ts` },
  { fixture: "entry-imports-backlog.ts", target: `${ENGINE}/features.ts` },
  { fixture: "backlog-import.ts", target: `${ENGINE}/create/core.ts` },
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
