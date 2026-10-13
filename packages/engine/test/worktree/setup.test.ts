// Setting up a claimed worktree (DIPO-39; 0010 sections 8 and 9) against a real temporary
// repository with a locally made claim (no Backlog CLI, so the suite stays fast) and a fake step
// runner in place of the sandbox: the step order and environment, the env-file notice once per
// office, the free-space check before install, and the rollback of a failed setup. The full claim
// with a pushed branch and the real sandbox is `setup.ci.test.ts`.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import { WORKTREE_ADD_CONFIG } from "../../src/git/hardened";
import { readWorktreeSnapshot } from "../../src/git/snapshot";
import type { DiskProbe } from "../../src/platform/disk";
import type { CommandSpec, Resolution, RunProfile } from "../../src/scan/detect";
import type { StepRequest, StepResult } from "../../src/sandbox/step";
import {
  type ClaimRecord,
  ENV_FILES_RULE,
  findClaim,
  hasLiveClaim,
  SETUP_NOTICES,
  type SetupDone,
  type SetupOutcome,
  type SetupRequest,
  type SetupSkip,
  setupWorktree,
  SlotTable,
} from "../../src/worktree";
import { insertClaim } from "../../src/worktree/records";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  notices,
  ROOMY,
  TASK_1,
  TASK_FILE_1,
} from "./helpers";

const SECRET = "DEV-SECRET-77b2e0";
const FIXTURE = { fixture: BACKLOG_FIXTURE };
const ONE_GB: DiskProbe = { freeBytes: () => Promise.resolve(1_000_000_000) };

const resolved = (...commands: string[][]): Resolution<CommandSpec> => ({
  status: "resolved",
  value: { commands, cwd: "." },
  source: "standard",
  confidence: "high",
  evidence: "package.json",
});

function profile(overrides: Partial<RunProfile["capabilities"]> = {}): RunProfile {
  const none: Resolution<CommandSpec> = { status: "unresolved" };
  return {
    fingerprint: "f",
    toolchain: {
      packageManager: { status: "unresolved" },
      runtimeVersion: { status: "unresolved" },
      workspaces: [],
    },
    capabilities: {
      install: resolved(["bun", "install", "--frozen-lockfile"]),
      setup: resolved(["bun", "run", "setup"]),
      dev: none,
      test: none,
      lint: none,
      typecheck: none,
      verify: resolved(["bun", "run", "verify"]),
      build: none,
      ...overrides,
    },
    extraScripts: [],
    envFiles: [{ example: ".env.example", path: ".env", present: true, ignored: true }],
    devPorts: [
      {
        port: 5173,
        dir: ".",
        fixedInCode: false,
        honoursPort: true,
        source: "default",
        confidence: "low",
        evidence: "vite",
      },
    ],
    conformance: { level: "conforming", deviations: [] },
    runRefusal: null,
  };
}

/** A step runner that records each request and fails the script named in `failing`. */
function fakeSteps(failing: Record<string, StepResult> = {}) {
  const requests: StepRequest[] = [];
  const runStep = (request: StepRequest): Promise<StepResult> => {
    requests.push(request);
    return Promise.resolve(
      failing[request.script] ?? {
        outcome: "exited",
        code: 0,
        signal: null,
        timedOut: false,
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        warnings: [],
      },
    );
  };
  return { requests, runStep };
}

const exitedWith = (code: number, stderr: string): StepResult => ({
  outcome: "exited",
  code,
  signal: null,
  timedOut: false,
  stdout: { text: "seeding...\n", truncated: false },
  stderr: { text: stderr, truncated: false },
  warnings: [],
});

/**
 * The state `claimStory` leaves (worktree, lock, pinned snapshot, claim row, one claim commit),
 * made with plain git, so this test needs no Backlog CLI.
 */
async function localClaim(repo: TempRepo, s: ClaimSetup): Promise<ClaimRecord> {
  const start = (await repo.git("rev-parse", "HEAD")).trim();
  const path = join(s.git.worktreeRoot(), TASK_1);
  const runId = s.runId();
  await s.git.run(async (git) => {
    await git.ok(git.repository, ["worktree", "add", "--quiet", "-b", BRANCH_1, path, start], {
      config: WORKTREE_ADD_CONFIG,
    });
    await git.ok(git.repository, ["worktree", "lock", "--reason", `dipo ${runId}`, path]);
  });
  const file = join(path, TASK_FILE_1);
  writeFileSync(file, readFileSync(file, "utf8").replace("status: Ready", "status: In Progress"));
  const wt = (...args: string[]) => repo.run(["git", ...args], path);
  await wt("add", "--", TASK_FILE_1);
  await wt("commit", "--quiet", "-m", `${TASK_1}: status In Progress`);
  const claimSha = (await wt("rev-parse", "HEAD")).stdout.trim();
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
      claimSha,
      reused: false,
      snapshot,
      firstFeedback: null,
      claimedAt: s.t.clock.now(),
    }),
  );
  return findClaim(s.office, runId) as ClaimRecord;
}

/** Commits a `.gitignore` and creates an ignored `.env` in the main checkout. */
async function withEnvFile(repo: TempRepo): Promise<void> {
  writeFileSync(join(repo.dir, ".gitignore"), ".env\n");
  await repo.commitAll("fixture");
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
  chmodSync(join(repo.dir, ".env"), 0o600);
}

interface Harness {
  readonly s: ClaimSetup;
  readonly slots: SlotTable;
  run(
    claim: ClaimRecord,
    options?: {
      disk?: DiskProbe;
      steps?: ReturnType<typeof fakeSteps>;
      profile?: RunProfile | null;
      config?: Partial<SetupRequest["config"]["worktree"]>;
    },
  ): Promise<SetupOutcome>;
}

async function harness(repo: TempRepo): Promise<Harness> {
  const s = await claimSetup(repo);
  const slots = SlotTable.inState(join(repo.root, "state-dir"));
  return {
    s,
    slots,
    run: (claim, options = {}) =>
      setupWorktree(
        {
          ...s.deps({ disk: options.disk ?? ROOMY }),
          slots,
          runStep: (options.steps ?? fakeSteps()).runStep,
        },
        {
          claim,
          config: {
            worktree: {
              ...OFFICE_DEFAULTS.worktree,
              files: [{ path: ".env", mode: "copy", required: true }],
              env: { VITE_HMR_PORT: "{port:24678}" },
              post_create: [
                ["bun", "run", "db:seed"],
                ["echo", "$HOME;", "rm -rf /"],
              ],
              ...options.config,
            },
            timeouts: OFFICE_DEFAULTS.timeouts,
            sandbox: OFFICE_DEFAULTS.sandbox,
          },
          profile: options.profile === undefined ? profile() : options.profile,
          host: { home: repo.home, uid: 501, env: { PATH: "/usr/bin:/bin", HOME: repo.home } },
        },
      ),
  };
}

function done(outcome: SetupOutcome): SetupDone {
  if (!outcome.ok) throw new Error(`setup failed: ${outcome.notice}\n${outcome.log}`);
  return outcome;
}

function skipped(outcome: SetupOutcome): SetupSkip {
  if (outcome.ok) throw new Error("expected setup to fail");
  return outcome;
}

async function branchExists(repo: TempRepo): Promise<boolean> {
  return (
    (await repo.run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH_1}`]))
      .exitCode === 0
  );
}

describe("setting up a claimed worktree", () => {
  it("copies files, takes slot 1 and runs install, setup and post_create in order with the run environment", async () => {
    await withTempRepo(async (repo) => {
      await withEnvFile(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();

      const outcome = done(await h.run(claim, { steps }));

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
      expect(readFileSync(join(claim.worktree, ".env"), "utf8")).toContain(SECRET);

      // In order, as argument lists, each with the run environment and its policy.
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
      expect(hasLiveClaim(h.s.office, claim.key)).toBe(true);
      expect(outcome.log.join("\n")).not.toContain(SECRET);
    }, FIXTURE);
  });

  it("shows the env-file notice once per office, listing the files, and never their contents", async () => {
    await withTempRepo(async (repo) => {
      await withEnvFile(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      done(await h.run(claim));
      // A second setup in the same office (here: after removing the first worktree's slot).
      h.slots.free(claim.worktree);
      await h.s.git.run((git) =>
        git.ok(git.repository, ["worktree", "remove", "--force", "--force", claim.worktree]),
      );
      h.s.git.unpinWorktree(claim.worktree);
      await repo.git("branch", "-D", BRANCH_1);
      h.s.office.run("update claims set released_at = 1 where office_id = $office_id");
      done(await h.run(await localClaim(repo, h.s)));

      const envNotices = notices(h.s.office).filter((n) => n.code === SETUP_NOTICES.envFiles);
      expect(envNotices).toHaveLength(1);
      expect(envNotices[0]?.text).toContain(ENV_FILES_RULE);
      expect(envNotices[0]?.text).toContain(".env");
      expect(JSON.stringify(notices(h.s.office))).not.toContain(SECRET);
    }, FIXTURE);
  });

  it("with 1 GB free before install fails, names the free space and rolls the claim back", async () => {
    await withTempRepo(async (repo) => {
      await withEnvFile(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();

      const outcome = skipped(await h.run(claim, { disk: ONE_GB, steps }));

      expect(outcome.reason).toBe("pickupCheckFailed");
      expect(outcome.code).toBe(SETUP_NOTICES.failed);
      expect(outcome.log).toContain("has 1.0 GB free, less than the 2.0 GB");
      expect(steps.requests).toEqual([]);
      expect(existsSync(claim.worktree)).toBe(false);
      expect(await branchExists(repo)).toBe(false);
      expect(h.slots.slotOf(claim.worktree)).toBeNull();
      const ended = findClaim(h.s.office, claim.runId);
      expect(ended?.releaseReason).toBe("setup-failed");
      expect(hasLiveClaim(h.s.office, claim.key)).toBe(false);
      expect(outcome.log).not.toContain(SECRET);
      // The base still has the story Ready.
      expect(readFileSync(join(repo.dir, TASK_FILE_1), "utf8")).toContain("status: Ready");
    }, FIXTURE);
  });

  it("a failing setup script rolls back with its output in the log", async () => {
    await withTempRepo(async (repo) => {
      await repo.commitAll("fixture");
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps({ setup: exitedWith(3, "database not reachable\n") });

      const outcome = skipped(
        await h.run(claim, { steps, config: { files: [], post_create: [] } }),
      );

      expect(steps.requests.map((r) => r.script)).toEqual(["install", "setup"]);
      expect(outcome.notice).toContain("setup (bun run setup) failed: exit 3");
      expect(outcome.log).toContain("database not reachable");
      expect(outcome.log).toContain(`rollback: worktree removed; ${BRANCH_1} deleted`);
      expect(existsSync(claim.worktree)).toBe(false);
      expect(await branchExists(repo)).toBe(false);
      expect(notices(h.s.office).map((n) => n.code)).toEqual([SETUP_NOTICES.failed]);
    }, FIXTURE);
  });

  it("fails without a run profile, on a sandbox that does not start and on a full slot table", async () => {
    await withTempRepo(async (repo) => {
      await repo.commitAll("fixture");
      const h = await harness(repo);
      const noFiles = { files: [], post_create: [] };

      let claim = await localClaim(repo, h.s);
      expect(skipped(await h.run(claim, { profile: null, config: noFiles })).notice).toContain(
        "no run profile",
      );

      claim = await localClaim(repo, h.s);
      const refused = fakeSteps({ install: { outcome: "startFailed", reason: "srt missing" } });
      expect(skipped(await h.run(claim, { steps: refused, config: noFiles })).notice).toContain(
        "did not start: srt missing",
      );

      claim = await localClaim(repo, h.s);
      h.slots.take({ office: "other", story: "X-1", worktree: repo.dir, takenAt: 0 }, 1);
      const full = skipped(await h.run(claim, { config: { ...noFiles, maxSlots: 1 } }));
      expect(full.notice).toContain("every port slot from 1 to 1 is taken");
      expect(existsSync(claim.worktree)).toBe(false);
    }, FIXTURE);
  });

  it("a tracked path in worktree.files fails setup and rolls back", async () => {
    await withTempRepo(async (repo) => {
      await repo.commitAll("fixture");
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const outcome = skipped(
        await h.run(claim, {
          config: { files: [{ path: "backlog/config.yml", mode: "copy", required: true }] },
        }),
      );
      expect(outcome.notice).toContain("git does not ignore backlog/config.yml");
      expect(existsSync(claim.worktree)).toBe(false);
    }, FIXTURE);
  });
});
