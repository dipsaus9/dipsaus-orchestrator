// The worktree list reconcile reads (DIPO-56): `git worktree list --porcelain -z` parsed into
// paths, HEADs, branches and prunable reasons. The git cases run in reconcile.ci.test.ts.

import { describe, expect, it } from "bun:test";

import { parseWorktreeList } from "../../src/reconcile";

describe("parseWorktreeList", () => {
  it("reads each entry's path, HEAD, branch and prunable reason", () => {
    const output = [
      "worktree /nowhere/repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /nowhere/trees/TASK-1",
      "HEAD bbbb",
      "detached",
      "locked dipo run_1",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/nowhere/repo", head: "aaaa", branch: "refs/heads/main", prunable: null },
      {
        path: "/nowhere/trees/TASK-1",
        head: "bbbb",
        branch: null,
        prunable: "gitdir file points to non-existent location",
      },
    ]);
  });
});
