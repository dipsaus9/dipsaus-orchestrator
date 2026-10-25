// The path classifier of the `changes` job (0016): backlog-only for backlog paths only, full for a
// mixed or empty list, and the paths come from the PR's merge base to its head.

import { describe, expect, it } from "bun:test";

import { withTempRepo } from "../packages/testkit/src/index";

import { changedPaths, changeScope } from "./changed-scope";

describe("changeScope", () => {
  it("is backlog-only when every path lies under backlog/", () => {
    expect(changeScope(["backlog/tasks/dipo-1 - A.md"])).toBe("backlog-only");
    expect(
      changeScope(["backlog/tasks/dipo-1 - A.md", "backlog/config.yml", "backlog/drafts/x.md"]),
    ).toBe("backlog-only");
  });

  it("is full for a mixed list", () => {
    expect(changeScope(["backlog/tasks/dipo-1 - A.md", "scripts/build.ts"])).toBe("full");
    expect(changeScope(["backlog/tasks/dipo-1 - A.md", ".dipo/.gitignore"])).toBe("full");
    expect(changeScope([".github/workflows/ci.yml"])).toBe("full");
  });

  it("is full for an empty list", () => {
    expect(changeScope([])).toBe("full");
  });

  it("is full for a path that only looks like backlog/", () => {
    expect(changeScope(["backlog"])).toBe("full");
    expect(changeScope(["backlog.md"])).toBe("full");
    expect(changeScope(["backlogs/x.md"])).toBe("full");
    expect(changeScope(["docs/backlog/x.md"])).toBe("full");
  });
});

describe("changedPaths", () => {
  it("lists the PR's changes from the merge base, a rename as both paths", async () => {
    await withTempRepo(async (repo) => {
      await Bun.write(`${repo.dir}/backlog/tasks/a.md`, "a\n");
      await Bun.write(`${repo.dir}/README.md`, "r\n");
      const base = await repo.commitAll("base");
      await repo.git("switch", "--quiet", "-c", "pr");
      await repo.git("mv", "backlog/tasks/a.md", "notes.md");
      const head = await repo.commitAll("pr");
      // The base moves on after the PR branched; its change is not the PR's.
      await repo.git("switch", "--quiet", "main");
      await Bun.write(`${repo.dir}/README.md`, "moved on\n");
      const moved = await repo.commitAll("main moves");
      expect(changedPaths(repo.dir, moved, head).toSorted()).toEqual([
        "backlog/tasks/a.md",
        "notes.md",
      ]);
      expect(changedPaths(repo.dir, base, base)).toEqual([]);
    });
  });

  it("throws when a commit is unknown, so no job is skipped on a guess", async () => {
    await withTempRepo(async (repo) => {
      const base = await repo.commitAll("base");
      expect(() => changedPaths(repo.dir, base, "0".repeat(40))).toThrow(/git diff/);
    });
  });
});
