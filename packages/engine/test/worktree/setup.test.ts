// Setting up a claimed worktree (DIPO-39; 0010 sections 7, 8 and 9) against real temporary
// repositories with a bare remote and a fake step runner in place of the sandbox. Through
// `claimStory`: setup runs after the worktree and before the claim commit and the push, and a
// failed setup (low disk, a failing script) rolls the claim back with nothing committed or pushed,
// the story Ready on origin/main; a release during a setup that fails keeps the release, its row
// and the branch. Directly: the step order and environment, the env-file notice once per office,
// and failures that free the slot and leave the rollback to the claim. The real sandbox is
// `setup.ci.test.ts`; a reused branch left exactly as released and a release during a setup that
// succeeds run in CI only, in `setup-claim.ci.test.ts` (DIPO-79).

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type TempRepo,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { WORKTREE_ADD_CONFIG } from "../../src/git/hardened";
import { formatLogLine } from "../../src/log/logger";
import { readWorktreeSnapshot } from "../../src/git/snapshot";
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
import { insertClaim } from "../../src/worktree/records";
import { outputTail } from "../../src/worktree/setup";
import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { BRANCH_1, type ClaimSetup, inRemote, notices, TASK_1, TASK_FILE_1 } from "./helpers";
import {
  exited,
  fakeSteps,
  FIXTURE,
  type Harness,
  harness,
  ONE_GB,
  type Options,
  product,
  releaseNow,
  SECRET,
  skipped,
} from "./setup-harness";

/** The state `claimStory` leaves before setup, made with plain git (no Backlog CLI). */
async function localClaim(repo: TempRepo, s: ClaimSetup): Promise<ClaimRecord> {
  const start = (await repo.git("rev-parse", "HEAD")).trim();
  const path = join(s.git.worktreeRoot(), TASK_1);
  const runId = s.runId();
  await s.git.run(async (g) => {
    await g.ok(g.repository, ["worktree", "add", "--quiet", "-b", BRANCH_1, path, start], {
      config: WORKTREE_ADD_CONFIG,
    });
    await g.ok(g.repository, ["worktree", "lock", "--reason", `dipo ${runId}`, path]);
  });
  const snapshot = readWorktreeSnapshot(path, s.git.adminDirOf(path) as string);
  s.git.pinWorktree(snapshot);
  s.office.immediate(() =>
    insertClaim(s.office, {
      runId,
      key: s.key(),
      story: TASK_1,
      branch: BRANCH_1,
      worktree: path,
      base: "main",
      baseSha: start,
      startSha: start,
      claimSha: null,
      reused: false,
      snapshot,
      firstFeedback: null,
      claimedAt: s.t.clock.now(),
    }),
  );
  return findClaim(s.office, runId) as ClaimRecord;
}

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

describe("setup inside the claim", () => {
  it("runs after the worktree and before the claim commit and the push", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const seen: string[] = [];
      const steps = fakeSteps({}, async () => {
        if (seen.length > 0) return;
        // At the first step: the branch is still at its start and not on the remote.
        seen.push((await repo.git("rev-parse", BRANCH_1)).trim());
        seen.push((await inRemote(repo, "branch", "--list", BRANCH_1)).trim());
      });

      const outcome = await h.claim(key, { steps });
      if (!outcome.ok) throw new Error(outcome.notice ?? "skipped");

      expect(seen).toEqual([outcome.claim.startSha, ""]);
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

  it("with 1 GB free before install fails, names the free space and leaves nothing", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const steps = fakeSteps();
      const request = {
        ...h.s.request(key),
        setup: (claim: ClaimRecord) => h.setup(claim, { disk: ONE_GB, steps }),
      };

      const outcome = skipped(await claimStory<SetupDone>(h.s.deps(), request));

      expect(outcome.reason).toBe("pickupCheckFailed");
      expect(outcome.code).toBe(SETUP_NOTICES.failed);
      expect(outcome.log).toContain("has 1.0 GB free, less than the 2.0 GB");
      expect(outcome.log).not.toContain(SECRET);
      expect(steps.requests).toEqual([]);
      expect(findClaim(h.s.office, request.runId)?.releaseReason).toBe("setup-failed");
      await assertRolledBack(repo, h, key);
    }, FIXTURE);
  });

  it("a failing setup script rolls the claim back with its output in the log", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const steps = fakeSteps({ setup: exited(3, "database not reachable\n") });
      const warnings: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
      const debugs: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];

      const outcome = skipped(
        await h.claim(key, {
          steps,
          worktree: { post_create: [] },
          warn: (message, fields) => warnings.push({ message, fields }),
          debug: (message, fields) => debugs.push({ message, fields }),
        }),
      );

      expect(steps.requests.map((r) => r.script)).toEqual(["install", "setup"]);
      // The notice names the step, its exit and the tail of what it printed.
      expect(outcome.notice).toContain(
        "setup (bun run setup) failed: exit 3: database not reachable",
      );
      // The failed step is logged at warn: command and exit; the output for debug lines.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe("a setup step failed");
      expect(warnings[0]?.fields).toMatchObject({
        script: "setup",
        command: "bun run setup",
        exitCode: 3,
      });
      expect(
        String(warnings[0]?.fields["stdout"]) + String(warnings[0]?.fields["stderr"]),
      ).toContain("database not reachable");
      expect(outcome.notice).toContain("stays Ready");
      // And how to read the rest of the step's output (DIPO-200): a warn line hides the output,
      // the debug line shows it, and the notice names the steps that bring the debug line up.
      expect(formatLogLine(0, "warn", warnings[0]!.message, {}, warnings[0]!.fields)).not.toContain(
        "database not reachable",
      );
      expect(debugs).toHaveLength(1);
      expect(formatLogLine(0, "debug", debugs[0]!.message, {}, debugs[0]!.fields)).toContain(
        "database not reachable",
      );
      expect(outcome.notice).toContain(
        "To read the step's output, run `dipo daemon log-level debug`, start the story again, then run `dipo daemon logs --level debug`.",
      );
      expect(outcome.log).toContain("database not reachable");
      expect(notices(h.s.office).map((n) => n.code)).toContain(SETUP_NOTICES.failed);
      await assertRolledBack(repo, h, key);
      // Nothing collides: the story can be claimed again.
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
      const steps = fakeSteps({ setup: exited(2, "broke\n") });
      const request = {
        ...h.s.request(key),
        setup: async (claim: ClaimRecord) => {
          const outcome = await h.setup(claim, { steps, worktree: { post_create: [] } });
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

  it("an install that rewrites the tracked lockfile fails setup and names it with a frozen-install hint", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const worktree = join(h.s.git.worktreeRoot(), TASK_1);
      const steps = fakeSteps({}, () => {
        writeFileSync(join(worktree, "bun.lock"), '{ "rewritten": true }\n');
        return Promise.resolve();
      });

      const outcome = skipped(await h.claim(key, { steps, worktree: { post_create: [] } }));

      expect(outcome.reason).toBe("pickupCheckFailed");
      expect(outcome.notice).toContain("setup left files git does not ignore (bun.lock)");
      expect(outcome.notice).toContain("bun install --frozen-lockfile");
      await assertRolledBack(repo, h, key);
    }, FIXTURE);
  });
});

describe("setting up a worktree", () => {
  it("copies files, takes slot 1 and runs install, setup and post_create in order with the run environment", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();

      const outcome = done(await h.setup(claim, { steps }));

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
      expect(steps.requests.map((r) => [r.script, r.kind, r.command])).toEqual([
        ["install", "install", ["bun", "install", "--frozen-lockfile"]],
        ["setup", "verify", ["bun", "run", "setup"]],
        ["post_create", "verify", ["bun", "run", "db:seed"]],
        ["post_create", "verify", ["echo", "$HOME;", "rm -rf /"]],
      ]);
      for (const request of steps.requests) {
        expect(request.extraEnv).toEqual(outcome.env);
        expect(request.worktree).toBe(claim.worktree);
        expect(request.mainCheckout).toBe(h.s.git.mainWorktree);
      }
      expect(outcome.log.join("\n")).not.toContain(SECRET);
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

  it("fails without a run profile, on a step that does not start, a full slot table or a tracked path, and frees its slot", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const noFiles = { files: [], post_create: [] };
      const failed = async (options: Options): Promise<string> => {
        const outcome = await h.setup(claim, options);
        if (outcome.ok) throw new Error("expected setup to fail");
        expect(h.slots.slotOf(claim.worktree)).toBeNull();
        return outcome.reason;
      };

      expect(await failed({ profile: null, worktree: noFiles })).toContain("no run profile");
      const refused = fakeSteps({ install: { outcome: "startFailed", reason: "srt missing" } });
      expect(await failed({ steps: refused, worktree: noFiles })).toContain(
        "did not start: srt missing",
      );
      expect(
        await failed({
          worktree: { files: [{ path: "backlog/config.yml", mode: "copy", required: true }] },
        }),
      ).toContain("git does not ignore backlog/config.yml");
      const writer = fakeSteps({}, () => {
        writeFileSync(join(claim.worktree, "generated.txt"), "x");
        return Promise.resolve();
      });
      expect(await failed({ steps: writer, worktree: noFiles })).toContain(
        "setup left files git does not ignore (generated.txt)",
      );
      rmSync(join(claim.worktree, "generated.txt"));
      h.slots.take({ office: "other", story: "X-1", worktree: repo.dir, takenAt: 0 }, 1);
      expect(await failed({ worktree: { ...noFiles, maxSlots: 1 } })).toContain(
        `every port slot from 1 to 1 is taken by another worktree: slot 1: office other, story X-1, worktree ${repo.dir}`,
      );
      // setupWorktree leaves the worktree; the claim's rollback removes it.
      expect(existsSync(claim.worktree)).toBe(true);
    }, FIXTURE);
  });
});

describe("the output tail a setup failure carries", () => {
  it("is the end of the output on one line, bounded, and null for no output", () => {
    expect(outputTail({ text: "\n  first line\nsecond  line\n", truncated: false })).toBe(
      "first line second line",
    );
    const long = outputTail({ text: `${"x".repeat(500)}END`, truncated: false }, 10);
    expect(long).toBe("…xxxxxxxEND");
    expect(outputTail({ text: " \n", truncated: false })).toBeNull();
  });
});
