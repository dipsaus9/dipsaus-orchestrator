// Local cases of the park and unpark commits on real git and the pinned Backlog CLI (DIPO-112;
// 0010 section 2a): each commits the story's task file alone, so a path staged in the worktree
// before the park stays staged and out of the commit. No remote: the claim cuts the branch from
// the local `main`, and nothing is pushed. The full park flow runs in CI (park.ci.test.ts).

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { gitParkWriter, gitUnparkWriter } from "../../src/run/park";
import { claimStory, type ClaimOutcome } from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  filesOf,
  publish,
  TASK_1,
  TASK_FILE_1,
} from "../worktree/helpers";

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`expected a claim, got the skip ${outcome.reason}: ${outcome.notice}`);
  return outcome;
}

async function staged(worktree: string, home: string): Promise<string[]> {
  const out = await git(worktree, home, "diff", "--cached", "--name-only");
  return out.split("\n").filter((line) => line !== "");
}

describe("the park and unpark commits", () => {
  it("leave a path staged before the park out of the park and unpark commits", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
        const deps = { git: () => s.git, cli: s.cli };

        // Verified work staged but not yet committed when the park comes.
        writeFileSync(join(claim.worktree, "work.txt"), "work\n");
        await git(claim.worktree, repo.home, "add", "work.txt");

        const park = await gitParkWriter(deps).write(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          reason: "stopped",
          note: "Not now.",
        });

        expect(park.commit).not.toBeNull();
        expect(park.pushed).toBe(false);
        expect(park.pushError).toBeNull();
        const parkSubject = await git(claim.worktree, repo.home, "log", "-1", "--format=%s");
        expect(parkSubject.trim()).toBe(`${TASK_1}: status Parked`);
        expect(await filesOf(repo.dir, repo.home, park.commit as string)).toEqual([TASK_FILE_1]);
        expect(await staged(claim.worktree, repo.home)).toEqual(["work.txt"]);

        const lift = await gitUnparkWriter(deps).lift(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          to: "In Progress",
        });

        expect(lift.commit).not.toBeNull();
        const liftSubject = await git(claim.worktree, repo.home, "log", "-1", "--format=%s");
        expect(liftSubject.trim()).toBe(`${TASK_1}: status In Progress`);
        expect(await filesOf(repo.dir, repo.home, lift.commit as string)).toEqual([TASK_FILE_1]);
        expect(await staged(claim.worktree, repo.home)).toEqual(["work.txt"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
