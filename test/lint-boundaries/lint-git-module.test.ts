// Asserts that lint keeps git inside the git module (0010; DIPO-348). Outside
// `packages/engine/src/git/**`:
// - `dipo/no-git-spawn`: no product file starts git, through an injected spawn, `node:child_process`
//   or a `$` template, by name or absolute path, directly, through a constant or a shorthand
//   `{ cmd }`;
// - `dipo/no-git-write`: no product file passes a git argument list that commits, moves or deletes
//   a ref, or pushes, whether straight to a call, through a conditional, bound to a name, behind
//   `-c key=value` or `-C dir`, or in a `$` template.
// Tests and testkit may run git; reads may run anywhere. The CLI's repository lookup may start git
// for its reads, but a git write there is still reported.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const SPAWN = "dipo(no-git-spawn)";
const WRITE = "dipo(no-git-write)";

/** `spawn` and `write` count the diagnostics of each rule the fixture gets at that place. */
type Case = { fixture: string; target: string; spawn: number; write: number };

const violations: Case[] = [
  // `program ?? "git"` in a cmd list, and execFile("git").
  { fixture: "git-spawn.ts", target: "packages/engine/src/office/spawn.ts", spawn: 2, write: 0 },
  { fixture: "git-spawn.ts", target: "packages/engine/src/platform/spawn.ts", spawn: 2, write: 0 },
  { fixture: "git-spawn.ts", target: "packages/daemon/src/spawn.ts", spawn: 2, write: 0 },
  { fixture: "git-spawn.ts", target: "packages/cli/src/spawn.ts", spawn: 2, write: 0 },
  {
    fixture: "git-spawn-absolute.ts",
    target: "packages/engine/src/run/absolute.ts",
    spawn: 1,
    write: 0,
  },
  // A shorthand `{ cmd }` bound to a constant list, and execFile(GIT) with GIT = "git".
  { fixture: "git-spawn-const.ts", target: "packages/engine/src/run/const.ts", spawn: 2, write: 0 },
  // `$` git status and `$` /usr/bin/git push, which is also a write.
  {
    fixture: "git-spawn-template.ts",
    target: "packages/engine/src/run/template.ts",
    spawn: 2,
    write: 1,
  },
  // push, commit-tree, update-ref in a conditional, branch -D by name, worktree add -b, reset.
  {
    fixture: "git-write-step.ts",
    target: "packages/engine/src/worktree/claim.ts",
    spawn: 0,
    write: 6,
  },
  {
    fixture: "git-write-step.ts",
    target: "packages/engine/src/backlog/lane/lane.ts",
    spawn: 0,
    write: 6,
  },
  {
    fixture: "git-write-step.ts",
    target: "packages/engine/src/merge-slot/git.ts",
    spawn: 0,
    write: 6,
  },
  // commit behind -c key=value, push behind -C dir; status behind -c is a read.
  {
    fixture: "git-write-options.ts",
    target: "packages/engine/src/run/options.ts",
    spawn: 0,
    write: 2,
  },
  // The CLI's repository lookup may start git, but not write with it.
  { fixture: "git-write-step.ts", target: "packages/cli/src/workspace.ts", spawn: 0, write: 6 },
];

const allowed: { fixture: string; target: string }[] = [
  { fixture: "git-spawn.ts", target: "packages/engine/src/git/runner.ts" },
  { fixture: "git-spawn-template.ts", target: "packages/engine/src/git/shell.ts" },
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

const hitsOf = (diagnostics: Diagnostic[], rule: string, target: string) =>
  diagnostics.filter((d) => d.code === rule && d.severity === "error" && d.filename === target)
    .length;

describe("oxlint git module", () => {
  for (const c of violations) {
    it(
      `reports ${c.fixture} at ${c.target}: ${c.spawn} spawn, ${c.write} write`,
      () => {
        const { exitCode, diagnostics } = lintViolations();
        expect(exitCode).not.toBe(0);
        expect(hitsOf(diagnostics, SPAWN, c.target)).toBe(c.spawn);
        expect(hitsOf(diagnostics, WRITE, c.target)).toBe(c.write);
      },
      LINT_TIMEOUT_MS,
    );
  }

  it(
    "allows git in the git module, tests, testkit and the CLI's repository lookup, and reads anywhere",
    () => {
      const { diagnostics } = lintTree(allowed);
      expect(diagnostics.filter((d) => d.code === SPAWN || d.code === WRITE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
