// dipo's own copy of a story's backlog (DIPO-349; 0010) on real git: an edit commits the task file
// alone on top of the branch tip it read, and moves the branch only from that tip. A branch that
// moved while the CLI ran is refused with `git.failed`, and the ref stays where it was moved to, so
// no commit is lost.

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { GitError } from "../../src/git";
import { editInStoryBacklog } from "../../src/stories/story-copy";
import { claimStory } from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  filesOf,
  publish,
  TASK_1,
  TASK_FILE_1,
} from "../worktree/helpers";

/** Runs git in the repository synchronously, outside dipo's git queue. */
function gitSync(repo: TempRepo, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }).trim();
}

describe("an edit in dipo's copy of a story's backlog", () => {
  it("commits the task file alone on the branch tip, and no worktree is made", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claimed = await claimStory(s.deps(), s.request(s.key()));
        expect(claimed.ok).toBe(true);
        const before = (await repo.git("rev-parse", BRANCH_1)).trim();

        const { commit } = await s.git.run((session) =>
          editInStoryBacklog(
            s.git,
            session,
            { story: TASK_1, branch: BRANCH_1 },
            `${TASK_1}: a note`,
            async (copy) => {
              appendFileSync(join(copy.cwd, copy.taskFile), "\nA note.\n");
            },
          ),
        );

        expect(commit).not.toBeNull();
        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(commit as string);
        expect((await repo.git("rev-parse", `${commit}^`)).trim()).toBe(before);
        expect(await filesOf(repo.dir, repo.home, commit as string)).toEqual([TASK_FILE_1]);
        expect(await repo.git("worktree", "list", "--porcelain")).not.toContain(BRANCH_1);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses with git.failed when the branch moved while the CLI ran, and leaves the ref as moved", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claimed = await claimStory(s.deps(), s.request(s.key()));
        expect(claimed.ok).toBe(true);
        const tip = (await repo.git("rev-parse", BRANCH_1)).trim();
        let moved = "";

        const error = await s.git
          .run((session) =>
            editInStoryBacklog(
              s.git,
              session,
              { story: TASK_1, branch: BRANCH_1 },
              `${TASK_1}: a note`,
              async (copy) => {
                appendFileSync(join(copy.cwd, copy.taskFile), "\nA note.\n");
                // Someone moves the branch while the CLI runs, outside dipo's git queue.
                moved = gitSync(repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "theirs");
                gitSync(repo, "update-ref", `refs/heads/${BRANCH_1}`, moved, tip);
              },
            ),
          )
          .then(
            () => null,
            (caught: unknown) => caught,
          );

        expect(error).toBeInstanceOf(GitError);
        expect((error as GitError).code).toBe("git.failed");
        expect((error as GitError).message).toContain("moved from");
        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(moved);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
