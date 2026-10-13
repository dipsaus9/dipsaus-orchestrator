// CI only (0017 section 1): the slower cases of setup inside the claim with the fake step runner
// (DIPO-39; 0010 sections 2a and 7), against a bare remote and the pinned Backlog CLI, moved out of
// setup.test.ts for the local time budget (DIPO-79): a reused branch is left exactly as released,
// locally and on the remote, when setup fails; and a release during a setup that succeeds keeps the
// release, its row and the branch. The fast local versions are in setup.test.ts: a release during
// a setup that fails keeps the release, its row and the branch at its start, and a failed setup
// rolls the claim back. The real sandbox is setup.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  type ClaimRecord,
  claimStory,
  findClaim,
  releaseClaim,
  releasedBranchFor,
  type SetupDone,
} from "../../src/worktree";
import { BRANCH_1, inRemote, TASK_1 } from "./helpers";
import { exited, fakeSteps, FIXTURE, harness, product, releaseNow, skipped } from "./setup-harness";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("setup inside the claim", () => {
    it("leaves a reused branch exactly as released when setup fails", async () => {
      await withBareRemote(async (repo) => {
        await product(repo);
        const h = await harness(repo);
        const key = h.s.key();
        const first = await h.claim(key);
        if (!first.ok) throw new Error("first claim skipped");
        const wt = first.claim.worktree;
        await repo.git("worktree", "unlock", wt);
        await repo.git("worktree", "remove", "--force", wt);
        h.s.git.unpinWorktree(wt);
        first.setup?.release();
        h.s.office.immediate(() =>
          releaseClaim(h.s.office, first.claim.runId, {
            at: h.s.t.clock.now(),
            reason: "amend",
            keepBranch: true,
          }),
        );
        const releasedTip = (await repo.git("rev-parse", BRANCH_1)).trim();
        const remoteTip = (await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim();

        const steps = fakeSteps({ install: exited(1, "lockfile out of date\n") });
        skipped(await h.claim(key, { steps }));

        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(releasedTip);
        expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(
          remoteTip,
        );
        expect(releasedBranchFor(h.s.office, key, BRANCH_1)).not.toBeNull();
        expect(existsSync(wt)).toBe(false);
      }, FIXTURE);
    });
  });

  describe("releases and restarts around setup", () => {
    it("a release during a setup that succeeds keeps the release, its row and the branch", async () => {
      await withBareRemote(async (repo) => {
        await product(repo);
        const h = await harness(repo);
        const key = h.s.key();
        const steps = fakeSteps({});
        const request = {
          ...h.s.request(key),
          setup: async (claim: ClaimRecord) => {
            const outcome = await h.setup(claim, { steps, worktree: { post_create: [] } });
            releaseNow(h, claim);
            return outcome;
          },
        };

        const outcome = skipped(await claimStory<SetupDone>(h.s.deps(), request));

        expect(outcome.reason).toBe("notRunnable");
        const row = findClaim(h.s.office, request.runId);
        expect(row?.releaseReason).toBe("amend");
        const start = row?.startSha as string;
        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(start);
        expect(releasedBranchFor(h.s.office, key, BRANCH_1)).not.toBeNull();
        expect(existsSync(join(h.s.git.worktreeRoot(), TASK_1))).toBe(false);
        expect(h.slots.slotOf(join(h.s.git.worktreeRoot(), TASK_1))).toBeNull();
        expect((await inRemote(repo, "branch", "--list", BRANCH_1)).trim()).toBe("");
      }, FIXTURE);
    });
  });
}
