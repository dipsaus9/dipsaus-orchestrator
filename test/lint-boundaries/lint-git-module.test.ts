// Asserts that lint keeps git inside the git module (0010; DIPO-348): outside
// `packages/engine/src/git/**`, no product file starts git (an injected spawn, `Bun.spawn`, or
// `node:child_process`), and no product file passes a git argument list that commits, moves or
// deletes a ref, or pushes, whether straight to a call, through a conditional or bound to a name.
// Tests, testkit and the CLI's repository lookup may run git; reads may run anywhere.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const RULE = "dipo(git-module-only)";

/** `count` is the number of diagnostics the fixture gets at that place. */
type Case = { fixture: string; target: string; count: number };

const violations: Case[] = [
  { fixture: "git-spawn.ts", target: "packages/engine/src/office/spawn.ts", count: 2 },
  { fixture: "git-spawn.ts", target: "packages/engine/src/platform/spawn.ts", count: 2 },
  { fixture: "git-spawn.ts", target: "packages/daemon/src/spawn.ts", count: 2 },
  { fixture: "git-spawn.ts", target: "packages/cli/src/spawn.ts", count: 2 },
  // push, commit-tree, update-ref in a conditional, branch -D by name, worktree add -b, reset.
  { fixture: "git-write-step.ts", target: "packages/engine/src/worktree/claim.ts", count: 6 },
  { fixture: "git-write-step.ts", target: "packages/engine/src/backlog/lane/lane.ts", count: 6 },
  { fixture: "git-write-step.ts", target: "packages/engine/src/merge-slot/git.ts", count: 6 },
];

const allowed: Omit<Case, "count">[] = [
  { fixture: "git-spawn.ts", target: "packages/engine/src/git/runner.ts" },
  { fixture: "git-write-step.ts", target: "packages/engine/src/git/write.ts" },
  { fixture: "git-read-step.ts", target: "packages/engine/src/worktree/claim.ts" },
  { fixture: "git-spawn.ts", target: "packages/engine/src/run/spawn.test.ts" },
  { fixture: "git-write-step.ts", target: "packages/engine/test/worktree/helpers.ts" },
  { fixture: "git-spawn.ts", target: "packages/testkit/src/git.ts" },
  { fixture: "git-spawn.ts", target: "packages/cli/src/workspace.ts" },
];

let violationRun: { exitCode: number; diagnostics: Diagnostic[] } | undefined;
function lintViolations() {
  violationRun ??= lintTree(violations);
  return violationRun;
}

describe("oxlint git module", () => {
  for (const c of violations) {
    it(
      `reports ${c.fixture} at ${c.target} with ${RULE} (${c.count}x)`,
      () => {
        const { exitCode, diagnostics } = lintViolations();
        expect(exitCode).not.toBe(0);
        const hits = diagnostics.filter(
          (d) => d.code === RULE && d.severity === "error" && d.filename === c.target,
        );
        expect(hits.length).toBe(c.count);
      },
      LINT_TIMEOUT_MS,
    );
  }

  it(
    "allows git in the git module, tests, testkit and the CLI's repository lookup, and reads anywhere",
    () => {
      const { diagnostics } = lintTree(allowed);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
