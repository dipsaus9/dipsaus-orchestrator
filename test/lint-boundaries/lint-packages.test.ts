// Asserts the package bans of 0004 in one rule, `dipo/package-imports` (DIPO-318 AC #9): what each
// package may import of the others, in every import form, a dynamic import, `require` and
// `import.meta.require` included; no reach into another package's files by relative path; testkit
// only in the tests of the packages that use it; and the contract's purity, nothing but zod and its
// own files, in every contract source file, also one in a subdirectory.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Placement } from "./lint-tree";

const RULE = "dipo(package-imports)";

/** Each placement, with the hits of the rule it must give. */
const cases: (Placement & { readonly hits: number })[] = [
  { fixture: "package-dynamic-engine.ts", target: "packages/tui/src/lazy.ts", hits: 3 },
  { fixture: "package-dynamic-engine.ts", target: "packages/client/src/lazy.ts", hits: 3 },
  { fixture: "package-dynamic-engine.ts", target: "packages/testkit/src/lazy.ts", hits: 3 },
  { fixture: "engine-imports-packages.ts", target: "packages/engine/src/run/leak.ts", hits: 4 },
  { fixture: "daemon-imports-packages.ts", target: "packages/daemon/src/leak.ts", hits: 3 },
  { fixture: "relative-into-package.ts", target: "packages/cli/src/reach.ts", hits: 3 },
  { fixture: "relative-into-package.ts", target: "packages/cli/test/reach.ts", hits: 3 },
  { fixture: "contract-impure.ts", target: "packages/contract/src/impure.ts", hits: 5 },
  { fixture: "contract-impure.ts", target: "packages/contract/src/deep/er/impure.ts", hits: 5 },
  { fixture: "testkit-import.ts", target: "packages/engine/src/run/clock.ts", hits: 1 },
  { fixture: "testkit-import.ts", target: "packages/tui/src/clock.test.ts", hits: 1 },
  { fixture: "testkit-import.ts", target: "packages/engine/test/run/clock.ts", hits: 0 },
  { fixture: "testkit-import.ts", target: "packages/cli/src/clock.test.ts", hits: 0 },
  { fixture: "cli-allowed.ts", target: "packages/cli/src/allowed.ts", hits: 0 },
  { fixture: "tui-allowed.ts", target: "packages/tui/src/allowed.ts", hits: 0 },
];

describe("the package bans (0004)", () => {
  it(
    "report each banned import in every form, and nothing where a package may import",
    () => {
      const { diagnostics } = lintTree(cases);
      for (const c of cases) {
        const hits = diagnostics.filter(
          (d) => d.code === RULE && d.severity === "error" && d.filename === c.target,
        );
        expect({ target: c.target, hits: hits.length }).toEqual({
          target: c.target,
          hits: c.hits,
        });
      }
    },
    LINT_TIMEOUT_MS,
  );
});
