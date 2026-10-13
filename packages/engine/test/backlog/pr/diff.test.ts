// Restoring the backlog worktree after the PR diff (DIPO-35): when reading the diff fails and the
// restore checkout fails too, both errors are reported, not only the restore's.

import { describe, expect, it } from "bun:test";

import { collectPrDiff, RestoreError } from "../../../src/backlog/pr/diff";
import type { GitSession } from "../../../src/git/office";
import { scriptedSpawn } from "../helpers";

const WORKTREE = {
  kind: "worktree",
  commonDir: "/repo/.git",
  gitDir: "/repo/.git/worktrees/_backlog",
  workTree: "/worktrees/_backlog",
} as const;

function fakeGit(failRestore: boolean): { git: GitSession; calls: string[] } {
  const calls: string[] = [];
  const git: GitSession = {
    repository: { kind: "repository", commonDir: "/repo/.git" },
    step: async (_location, args) => {
      calls.push(args.join(" "));
      return args[0] === "symbolic-ref"
        ? { code: 0, stdout: "dipo/backlog-x\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    },
    ok: async (_location, args) => {
      calls.push(args.join(" "));
      if (args[0] === "diff") return "backlog/tasks/task-1 - A.md\0";
      if (args[0] === "ls-tree") throw new Error("ls-tree broke");
      if (args[0] === "checkout" && args.includes("dipo/backlog-x") && failRestore) {
        throw new Error("checkout broke");
      }
      return "";
    },
  };
  return { git, calls };
}

describe("collectPrDiff", () => {
  it("reports both the diff error and a failed restore", async () => {
    const { git } = fakeGit(true);
    const cli = { spawn: scriptedSpawn(() => ({})).spawn };
    const error = await collectPrDiff({ git, worktree: WORKTREE, cli, base: "a", head: "b" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as Error).message).toContain("ls-tree broke");
    expect((error as Error).message).toContain("checkout broke");
  });

  it("restores the branch and rethrows the diff error when the restore works", async () => {
    const { git, calls } = fakeGit(false);
    const cli = { spawn: scriptedSpawn(() => ({})).spawn };
    const error = await collectPrDiff({ git, worktree: WORKTREE, cli, base: "a", head: "b" }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("ls-tree broke");
    expect(calls).toContain("checkout --quiet --force --no-recurse-submodules dipo/backlog-x");
  });
});
