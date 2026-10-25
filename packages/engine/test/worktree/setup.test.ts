// Setting up a claimed worktree (DIPO-39; 0010 sections 7, 8 and 9) against real temporary
// repositories with a bare remote. Through `claimStory`: setup runs after the worktree and before
// the claim commit and the push, and a failed setup (a full slot table) rolls the claim back with
// nothing committed or pushed, the story Ready on origin/main; a release during a setup that fails
// keeps the release, its row and the branch. Directly: the slot and the run environment, the
// env-file notice once per office, failures that free the slot and leave the rollback to the
// claim, and no install, script or verify on the Mac (DIPO-240: the box gets the packages). A
// reused branch left exactly as released and a release during a setup that succeeds run in CI
// only, in `setup-claim.ci.test.ts` (DIPO-79).

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type TempRepo,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import {
  CLAIM_NOTICES,
  type ClaimRecord,
  claimStory,
  ENV_FILES_RULE,
  findClaim,
  hasLiveClaim,
  releasedBranchFor,
  SETUP_NOTICES,
  type SetupDone,
  type SetupOutcome,
  StoryClaims,
} from "../../src/worktree";
import type { OfficeLoadContext } from "../../src/office/steps";
import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { BRANCH_1, inRemote, notices, TASK_1, TASK_FILE_1 } from "./helpers";
import {
  FIXTURE,
  type Harness,
  harness,
  localClaim,
  type Options,
  product,
  releaseNow,
  SECRET,
  skipped,
} from "./setup-harness";

function done(outcome: SetupOutcome): SetupDone {
  if (!outcome.ok) throw new Error(`setup failed: ${outcome.reason}\n${outcome.log}`);
  return outcome;
}

async function refExists(repo: TempRepo, ref: string): Promise<boolean> {
  return (await repo.run(["git", "rev-parse", "--verify", "--quiet", ref])).exitCode === 0;
}

/** Asserts what a rolled-back new branch leaves: nothing locally, on the remote or in the base. */
async function assertRolledBack(repo: TempRepoWithRemote, h: Harness, key: string): Promise<void> {
  const path = join(h.s.git.worktreeRoot(), TASK_1);
  expect(existsSync(path)).toBe(false);
  expect(await refExists(repo, `refs/heads/${BRANCH_1}`)).toBe(false);
  expect((await inRemote(repo, "branch", "--list", BRANCH_1)).trim()).toBe("");
  // The story stays Ready on the base the office reads (origin/main).
  expect(await repo.git("show", `origin/main:${TASK_FILE_1}`)).toContain("status: Ready");
  expect(h.slots.slotOf(path)).toBeNull();
  expect(hasLiveClaim(h.s.office, key as never)).toBe(false);
}

/** Takes the only slot for another worktree, so the next setup finds every slot taken. */
function fillSlots(h: Harness, repo: TempRepo): Options {
  h.slots.take({ office: "other", story: "X-1", worktree: repo.dir, takenAt: 0 }, 1);
  return { worktree: { maxSlots: 1 } };
}

describe("setup inside the claim", () => {
  it("runs after the worktree and before the claim commit and the push", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const seen: string[] = [];
      const outcome = await claimStory<SetupDone>(h.s.deps(), {
        ...h.s.request(key),
        // The caller hears of the committed claim row before setup starts (DIPO-314).
        onClaimed: () => seen.push("claimed"),
        setup: async (claim: ClaimRecord) => {
          // At setup: the branch is still at its start and not on the remote.
          seen.push((await repo.git("rev-parse", BRANCH_1)).trim());
          seen.push((await inRemote(repo, "branch", "--list", BRANCH_1)).trim());
          return h.setup(claim);
        },
      });
      if (!outcome.ok) throw new Error(outcome.notice ?? "skipped");

      expect(seen).toEqual(["claimed", outcome.claim.startSha, ""]);
      expect(outcome.setup?.slot).toBe(1);
      expect(outcome.setup?.env["DIPO_STORY"]).toBe(TASK_1);
      expect(outcome.pushed).toBe(true);
      expect(outcome.claim.claimSha).not.toBeNull();
      expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(
        outcome.claim.claimSha as string,
      );
      expect(readFileSync(join(outcome.claim.worktree, ".env"), "utf8")).toContain(SECRET);
    }, FIXTURE);
  });

  it("a setup that fails rolls the claim back with its reason in the notice", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const outcome = skipped(await h.claim(key, fillSlots(h, repo)));

      expect(outcome.reason).toBe("pickupCheckFailed");
      expect(outcome.code).toBe(SETUP_NOTICES.failed);
      expect(outcome.notice).toContain("every port slot from 1 to 1 is taken by another worktree");
      expect(outcome.notice).toContain("dipo discard <id> frees a story's slot.");
      expect(outcome.notice).toContain("stays Ready");
      expect(outcome.log).not.toContain(SECRET);
      expect(notices(h.s.office).map((n) => n.code)).toContain(SETUP_NOTICES.failed);
      await assertRolledBack(repo, h, key);
      // Nothing collides: the story can be claimed again once a slot is free.
      h.slots.free(repo.dir);
      const again = await h.claim(key);
      expect(again.ok).toBe(true);
    }, FIXTURE);
  });
});

describe("releases and restarts around setup", () => {
  // The variant with a setup that succeeds runs in CI only, in setup-claim.ci.test.ts (DIPO-79).
  it("a release during a setup that fails keeps the release, its row and the branch", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const full = fillSlots(h, repo);
      const request = {
        ...h.s.request(key),
        setup: async (claim: ClaimRecord) => {
          const outcome = await h.setup(claim, full);
          releaseNow(h, claim);
          return outcome;
        },
      };

      const outcome = skipped(await claimStory<SetupDone>(h.s.deps(), request));

      expect(outcome.reason).toBe("pickupCheckFailed");
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

  it("a daemon restart during setup rolls the unfinished claim back at office load", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      // The state a daemon leaves when it stops during setup: worktree, lock, live row without a
      // claim commit, a taken slot.
      const claim = await localClaim(repo, h.s);
      h.slots.take(
        { office: h.s.office.officeId, story: TASK_1, worktree: claim.worktree, takenAt: 0 },
        20,
      );

      // The restarted daemon loads the office.
      const claims = new StoryClaims({ git: () => h.s.git, cli: h.s.cli, slots: h.slots });
      expect(
        claims.attach({
          officeId: h.s.office.officeId,
          office: h.s.office,
          clock: h.s.t.clock,
        } as unknown as OfficeLoadContext),
      ).toBeNull();
      await claims.recover(h.s.office.officeId as OfficeId);

      expect(existsSync(claim.worktree)).toBe(false);
      expect(await refExists(repo, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(findClaim(h.s.office, claim.runId)?.releaseReason).toBe("setup-failed");
      expect(h.slots.slotOf(claim.worktree)).toBeNull();
      expect(notices(h.s.office).map((n) => n.code)).toContain(CLAIM_NOTICES.setupInterrupted);
      expect(await repo.git("show", `origin/main:${TASK_FILE_1}`)).toContain("status: Ready");
    }, FIXTURE);
  });
});

describe("setting up a worktree", () => {
  it("copies files, takes slot 1 and builds the run environment, and runs nothing on the Mac (DIPO-240)", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);

      const outcome = done(await h.setup(claim));

      expect(outcome.slot).toBe(1);
      expect(h.slots.slotOf(claim.worktree)).toBe(1);
      expect(outcome.env).toEqual({
        PORT: "5183",
        VITE_HMR_PORT: "24688",
        DIPO_SLOT: "1",
        DIPO_PORT_OFFSET: "10",
        DIPO_STORY: TASK_1,
        DIPO_WORKTREE: claim.worktree,
      });
      // No install, setup script, post_create or base verify: the box gets the packages, and CI
      // is the verify (0021 amendment of 2026-10-22).
      const log = outcome.log.join("\n");
      expect(log).not.toMatch(/install|post_create|base verify|\$ /);
      expect(existsSync(join(claim.worktree, "node_modules"))).toBe(false);
      expect(log).not.toContain(SECRET);
      outcome.release();
      expect(h.slots.slotOf(claim.worktree)).toBeNull();
    }, FIXTURE);
  });

  it("shows the env-file notice once per office, listing the files, and never their contents", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      done(await h.setup(claim));
      // A second copy of env files in the same office stays quiet.
      rmSync(join(claim.worktree, ".env"));
      done(await h.setup(claim));

      const envNotices = notices(h.s.office).filter((n) => n.code === SETUP_NOTICES.envFiles);
      expect(envNotices).toHaveLength(1);
      expect(envNotices[0]?.text).toContain(ENV_FILES_RULE);
      expect(envNotices[0]?.text).toContain(".env");
      expect(JSON.stringify(notices(h.s.office))).not.toContain(SECRET);
    }, FIXTURE);
  });

  it("fails on a full slot table or a tracked path, and frees its slot", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const failed = async (options: Options): Promise<string> => {
        const outcome = await h.setup(claim, options);
        if (outcome.ok) throw new Error("expected setup to fail");
        expect(h.slots.slotOf(claim.worktree)).toBeNull();
        return outcome.reason;
      };

      expect(
        await failed({
          worktree: { files: [{ path: "backlog/config.yml", mode: "copy", required: true }] },
        }),
      ).toContain("git does not ignore backlog/config.yml");
      h.slots.take({ office: "other", story: "X-1", worktree: repo.dir, takenAt: 0 }, 1);
      expect(await failed({ worktree: { files: [], maxSlots: 1 } })).toContain(
        `every port slot from 1 to 1 is taken by another worktree: slot 1: office other, story X-1, worktree ${repo.dir}. dipo discard <id> frees a story's slot.`,
      );
      // setupWorktree leaves the worktree; the claim's rollback removes it.
      expect(existsSync(claim.worktree)).toBe(true);
    }, FIXTURE);
  });

  it("succeeds without a run profile, which the box's own preparation refuses (DIPO-240)", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const outcome = done(await h.setup(claim, { profile: null }));
      expect(outcome.env["PORT"]).toBeUndefined();
    }, FIXTURE);
  });
});
