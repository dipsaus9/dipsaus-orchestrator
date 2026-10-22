// Local cases of the park and unpark commits on real git and the pinned Backlog CLI (DIPO-112;
// 0010 section 2a): each commits the story's task file alone, so a path staged in the worktree
// before the park stays staged and out of the commit. No remote: the claim cuts the branch from
// the local `main`, and nothing is pushed. The full park flow runs in CI (park.ci.test.ts).

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { setFinalSummary } from "../../src/backlog/fields/summary";
import { SECTION_RULE } from "../../src/backlog/plain";
import type { GitLocation } from "../../src/git/hardened";
import { writeCloseOutSummary } from "../../src/merge-slot/close-out";
import { gitParkWriter, gitUnparkWriter, type ParkBranchFacts } from "../../src/run/park";
import { claimStory, type ClaimOutcome } from "../../src/worktree";
import { editInStoryBacklog } from "../../src/worktree/claim";
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

/** The story's task file as committed at `commit`. */
const taskFileAt = (repo: { dir: string; home: string }, commit: string) =>
  git(repo.dir, repo.home, "show", `${commit}:${TASK_FILE_1}`);

describe("the structured summary in the task file (DIPO-154; 0020 section 13)", () => {
  it("appends the park block in the F16 commit, the resume line in the lift commit, and nothing on a repeated lift", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
        const deps = { git: () => s.git, cli: s.cli };
        // Uncommitted work and an untracked file, as a Mac worker leaves them.
        writeFileSync(join(claim.worktree, "work.txt"), "work\n");
        writeFileSync(join(claim.worktree, "notes.txt"), "notes\n");
        await git(claim.worktree, repo.home, "add", "work.txt");
        const seen: ParkBranchFacts[] = [];

        const park = await gitParkWriter(deps).write(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          reason: "budget-exceeded",
          note: "turn cap (--max-turns) after 61 turns",
          summary: (facts) => {
            seen.push(facts);
            return `Parked 2026-10-22 14:05 UTC: budget-exceeded (build)\n- Last good commit: ${facts.lastGoodCommit}\n- Uncommitted files: ${facts.uncommitted}`;
          },
        });

        // One commit holds the F16 block, the status and the block, and only the task file.
        expect(await filesOf(repo.dir, repo.home, park.commit as string)).toEqual([TASK_FILE_1]);
        expect(seen).toEqual([{ lastGoodCommit: park.lastGoodCommit, uncommitted: 2 }]);
        const parked = await taskFileAt(repo, park.commit as string);
        expect(parked).toContain("status: Parked");
        expect(parked).toContain("Parked 2026-10-22 14:05 UTC: budget-exceeded (build)");
        expect(parked).toContain(`- Last good commit: ${park.lastGoodCommit}`);
        expect(parked).toContain("- Uncommitted files: 2");

        const line = "Resumed 2026-10-22 15:00 UTC; grants: none; note: Carry on.";
        const lift = await gitUnparkWriter(deps).lift(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          to: "In Progress",
          line,
        });
        expect(await filesOf(repo.dir, repo.home, lift.commit as string)).toEqual([TASK_FILE_1]);
        const lifted = await taskFileAt(repo, lift.commit as string);
        expect(lifted).toContain(line);
        // The park block stays above the resume line.
        expect(lifted.indexOf("Parked 2026-10-22")).toBeLessThan(lifted.indexOf(line));

        // A lift already written (a restart repeating it) commits and appends nothing.
        const again = await gitUnparkWriter(deps).lift(s.office.officeId, {
          story: TASK_1,
          branch: BRANCH_1,
          worktree: claim.worktree,
          to: "In Progress",
          line,
        });
        expect(again.commit).toBeNull();
        const tip = await git(claim.worktree, repo.home, "rev-parse", "HEAD");
        expect((await taskFileAt(repo, tip.trim())).split(line)).toHaveLength(2);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("sets the final summary through the CLI and refuses a text with a line of 50 dashes", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
        const location = s.git.worktreeLocation(claim.worktree) as Extract<
          GitLocation,
          { kind: "worktree" }
        >;
        let written = "";
        const { commit } = await s.git.run((session) =>
          editInStoryBacklog(
            s.git,
            session,
            location,
            TASK_1,
            `${TASK_1}: close out`,
            async (b) => {
              const target = { cli: s.cli, cwd: b.cwd, id: TASK_1 };
              written = await writeCloseOutSummary(
                target,
                s.office,
                claim.key,
                Date.UTC(2026, 9, 22),
              );
              await expect(
                setFinalSummary(target, `Closed\n${SECTION_RULE}\nAcceptance Criteria:`),
              ).rejects.toThrow("a line of 50 `-`");
            },
          ),
        );
        expect(written.split("\n")[0]).toBe("Closed 2026-10-22 00:00 UTC");
        const closed = await taskFileAt(repo, commit as string);
        expect(closed).toContain("Closed 2026-10-22 00:00 UTC");
        expect(closed).toContain("- Runs: 0; resumes: 0");
        expect(closed.split("\n").some((l) => l.trimEnd() === SECTION_RULE)).toBe(false);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
