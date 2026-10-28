// The CLI's repository lookup, the one git call outside the engine's git module (0010, 0004): it
// runs hardened with the contract's shared definition, ignores inherited variables that would move
// git elsewhere or add config, and fails when git does not answer within its deadline.

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { type Clock, HARDENED_GIT_CONFIG, type TimerHandle } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { locateRepository, lookupGitCommand } from "./workspace";

describe("the CLI's repository lookup", () => {
  it("runs git with no pager and every hardened config, hooks off included", () => {
    const command = lookupGitCommand(["rev-parse", "--git-common-dir"]);
    expect(command.slice(0, 2)).toEqual(["git", "--no-pager"]);
    for (const [key, value] of HARDENED_GIT_CONFIG) {
      expect(command).toContain(`${key}=${value}`);
    }
    expect(command).toContain("core.hooksPath=/dev/null");
    expect(command.slice(-2)).toEqual(["rev-parse", "--git-common-dir"]);
  });

  it("finds the repository around a path although the environment points git elsewhere", async () => {
    await withTempRepo(async (repo) => {
      await repo.commitAll("first");
      const planted = {
        ...repo.env,
        GIT_DIR: "/nonexistent/.git",
        GIT_WORK_TREE: "/nonexistent",
        GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
      };
      const found = await locateRepository(repo.dir, planted);
      expect(found?.mainWorktree).toBe(realpathSync(repo.dir));
      expect(found?.commonDir).toBe(realpathSync(join(repo.dir, ".git")));
    });
  });

  it("fails when git does not answer before the deadline", async () => {
    await withTempRepo(async (repo) => {
      // A clock whose every timer fires at once: git is killed before it answers.
      const expired: Clock = {
        now: () => 0,
        setTimeout: (callback) => {
          callback();
          return 0 as unknown as TimerHandle;
        },
        clearTimeout: () => undefined,
      };
      expect(await locateRepository(repo.dir, repo.env, expired)).toBeNull();
    });
  });
});
