// The worktree list reconcile reads (DIPO-56): `git worktree list --porcelain -z` parsed into
// paths, HEADs, branches, prunable reasons and locks, and the worktrees whose directory is gone,
// including a locked one, which git never marks prunable. The other git cases run in
// reconcile.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { canonicalFuturePath } from "../../src/git/paths";
import { clearCommands, goneWorktrees, parseWorktreeList } from "../../src/reconcile";

describe("parseWorktreeList", () => {
  it("reads each entry's path, HEAD, branch, prunable reason and lock", () => {
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
      {
        path: "/nowhere/repo",
        head: "aaaa",
        branch: "refs/heads/main",
        prunable: null,
        locked: null,
      },
      {
        path: "/nowhere/trees/TASK-1",
        head: "bbbb",
        branch: null,
        prunable: "gitdir file points to non-existent location",
        locked: "dipo run_1",
      },
    ]);
  });
});

describe("goneWorktrees", () => {
  it("flags a locked dipo worktree whose directory was removed by hand, with the commands to clear it", () =>
    withTempRepo(async (repo) => {
      await repo.commitAll("initial");
      const tree = join(repo.root, "trees", "TASK-1");
      await repo.git("worktree", "add", "--quiet", "-b", "TASK-1/a-story", tree);
      await repo.git("worktree", "lock", "--reason", "dipo run_1", tree);
      rmSync(tree, { recursive: true, force: true });

      const listed = parseWorktreeList(await repo.git("worktree", "list", "--porcelain", "-z"));
      const entry = listed.find((w) => w.path === canonicalFuturePath(tree));
      // git shows the lock, not `prunable`.
      expect(entry).toMatchObject({ locked: "dipo run_1", prunable: null });

      const gone = goneWorktrees(listed);
      expect(gone).toEqual([
        {
          path: canonicalFuturePath(tree),
          reason: "locked (dipo run_1), its directory is missing",
          locked: true,
        },
      ]);
      expect(clearCommands(gone)).toBe(
        `git worktree unlock ${canonicalFuturePath(tree)} && git worktree prune`,
      );
      // A locked worktree whose directory still exists is not gone.
      expect(goneWorktrees(listed, () => true)).toEqual([]);
    }));
});
