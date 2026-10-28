// The close-out commit (0002; 0012 F16, 0010 story lane): on real git and the pinned Backlog CLI, a task file that holds an F16 park block when
// the close-out commit sets Done has no park key after it, in that one commit of the task file
// alone. No remote: the claim cuts the branch from the local `main`, and nothing is pushed.

import { describe, expect, it } from "bun:test";

import { git, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { gitStoryMergeOps } from "../../src/merge/story-git";
import { gitParkWriter } from "../../src/run/park";
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

/** The ```dipo field block of a task file's text. */
function dipoBlock(text: string): string {
  return /```dipo\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
}

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`expected a claim, got the skip ${outcome.reason}: ${outcome.notice}`);
  return outcome;
}

describe("the close-out commit", () => {
  it("sets Done and removes the F16 park block of the task file in the same commit", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
        const deps = { git: () => s.git, cli: s.cli };
        // DIPO-129: the story parked ambiguous-spec, and its park record was never removed.
        await gitParkWriter(deps).write(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          reason: "ambiguous-spec",
          note: "Which flag?",
        });
        const parked = await git(claim.worktree, repo.home, "show", `HEAD:${TASK_FILE_1}`);
        expect(dipoBlock(parked)).toContain(`reason: "ambiguous-spec"`);

        const run = {
          runId: claim.runId,
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          startSha: claim.startSha,
        };
        const summaries: string[] = [];
        const closeOut = () =>
          gitStoryMergeOps(deps).closeOut(s.office.officeId, run, async (target) => {
            summaries.push(target.id);
          });
        const done = { commit: await closeOut() };

        expect(done.commit).not.toBeNull();
        expect(summaries).toEqual([TASK_1]);
        const subject = await git(claim.worktree, repo.home, "log", "-1", "--format=%s");
        expect(subject.trim()).toBe(`${TASK_1}: status Done`);
        expect(await filesOf(repo.dir, repo.home, done.commit as string)).toEqual([TASK_FILE_1]);
        const closed = await git(claim.worktree, repo.home, "show", `HEAD:${TASK_FILE_1}`);
        expect(closed).toMatch(/^status: Done$/m);
        expect(dipoBlock(closed)).not.toMatch(/^park:/m);
        // The rest of the field block stays.
        expect(dipoBlock(closed)).toBe(dipoBlock(parked).replace(/^park:\n(?: {2}.*\n)*/m, ""));

        // Once Done with no park record, a second close-out commits nothing.
        expect(await closeOut()).toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);
});
