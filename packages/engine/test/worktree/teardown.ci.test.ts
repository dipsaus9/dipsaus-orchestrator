// CI only (0017): the Done poll and teardown against a real temporary repository, a bare remote
// and the pinned Backlog CLI (DIPO-58, DIPO-363, DIPO-349; 0002, 0010). The story branch is
// squash-merged on the bare remote, as the host's squash merge does, and its story PR recorded
// merged, as the PR poll records it; the one Done check finds it merged and the poll deletes the
// local and the remote branch. A claim has no worktree, so nothing else is removed. Fast versions
// of the same rules with a fake git are in teardown.test.ts.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { insertStoryPr } from "../../src/records/story-prs";
import {
  type ClaimOutcome,
  claimStory,
  DONE_RELEASE_REASON,
  findClaim,
  StoryTeardown,
  TEARDOWN_NOTICES,
} from "../../src/worktree";
import { squashMergeOnRemote } from "../backlog/lane/helpers";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  byHandOn,
  claimSetup,
  type ClaimSetup,
  inRemote,
  notices,
  publish,
} from "./helpers";
import { backlogStoryStore } from "../../src/backlog/store";

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a claim, got the skip ${outcome.reason}`);
  return outcome;
}

async function refExists(cwd: string, home: string, ref: string): Promise<boolean> {
  return git(cwd, home, "rev-parse", "--verify", "--quiet", ref).then(
    () => true,
    () => false,
  );
}

/**
 * Claims TASK-1, commits work on its branch by hand, pushes it, squash-merges it on the remote and
 * records its story PR merged at the pushed head.
 */
async function claimWorkMerge(repo: TempRepoWithRemote, s: ClaimSetup) {
  const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
  const head = await byHandOn(repo, BRANCH_1, async (dir) => {
    writeFileSync(join(dir, "work.txt"), "work\n");
    await git(dir, repo.home, "add", "work.txt");
    await git(dir, repo.home, "commit", "--quiet", "-m", "work");
    await git(dir, repo.home, "push", "--quiet", "origin", BRANCH_1);
    return (await git(dir, repo.home, "rev-parse", "HEAD")).trim();
  });
  await squashMergeOnRemote(repo, BRANCH_1);
  s.office.immediate(() =>
    insertStoryPr(s.office, {
      runId: claim.runId,
      key: claim.key,
      number: 1,
      url: "https://github.com/o/r/pull/1",
      branch: BRANCH_1,
      base: "main",
      headSha: head,
      state: "merged",
      title: "feat(TASK-1): x",
      bodyHash: "h",
      openedAt: 1,
      closedAt: 2,
    }),
  );
  const fetched = await s.git.fetch();
  if (!fetched.ok) throw fetched.error;
  return claim;
}

function teardownOf(s: ClaimSetup): StoryTeardown {
  const teardown = new StoryTeardown({
    git: () => s.git,
    host: null,
    stories: backlogStoryStore(s.cli),
    offices: { get: () => s.office, config: () => OFFICE_DEFAULTS },
  });
  teardown.track(s.office.officeId as OfficeId, s.office, s.t.clock);
  return teardown;
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("Done and teardown on a real repository", () => {
    it("finds a squash-merged PR Done and deletes both branches", async () => {
      await withBareRemote(
        async (repo) => {
          await publish(repo);
          const s = await claimSetup(repo);
          const claim = await claimWorkMerge(repo, s);
          // The branch is not an ancestor of the base after a squash merge.
          const ancestor = await repo.run([
            "git",
            "merge-base",
            "--is-ancestor",
            BRANCH_1,
            "origin/main",
          ]);
          expect(ancestor.exitCode).toBe(1);

          const report = await teardownOf(s).poll(s.office.officeId as OfficeId);

          expect(report.tornDown.map((c) => c.runId)).toEqual([claim.runId]);
          expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
          expect(await inRemote(repo, "branch", "--list", BRANCH_1).then((out) => out.trim())).toBe(
            "",
          );
          expect(findClaim(s.office, claim.runId)?.releaseReason).toBe(DONE_RELEASE_REASON);
          expect(notices(s.office).map((n) => n.code)).toContain(TEARDOWN_NOTICES.done);
          expect(await repo.git("worktree", "list", "--porcelain")).not.toContain(BRANCH_1);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });
}
