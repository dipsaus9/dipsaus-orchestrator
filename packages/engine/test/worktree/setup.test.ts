// Setting up a claimed worktree (DIPO-39; 0010 sections 7, 8 and 9) against real temporary
// repositories with a bare remote and a fake step runner in place of the sandbox. Through
// `claimStory`: setup runs after the worktree and before the claim commit and the push, and a
// failed setup (low disk, a failing script) rolls the claim back with nothing committed or pushed,
// the story Ready on origin/main, and a reused branch left exactly as released. Directly: the
// step order and environment, the env-file notice once per office, and failures that free the
// slot and leave the rollback to the claim. The real sandbox is `setup.ci.test.ts`.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type TempRepo,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import { WORKTREE_ADD_CONFIG } from "../../src/git/hardened";
import { readWorktreeSnapshot } from "../../src/git/snapshot";
import type { DiskProbe } from "../../src/platform/disk";
import type { CommandSpec, Resolution, RunProfile } from "../../src/scan/detect";
import type { StepRequest, StepResult } from "../../src/sandbox/step";
import {
  CLAIM_NOTICES,
  type ClaimOutcome,
  type ClaimRecord,
  type ClaimSkip,
  claimStory,
  ENV_FILES_RULE,
  findClaim,
  hasLiveClaim,
  releaseClaim,
  releasedBranchFor,
  SETUP_NOTICES,
  type SetupDone,
  type SetupOutcome,
  type SetupRequest,
  setupWorktree,
  SlotTable,
  StoryClaims,
} from "../../src/worktree";
import type { OfficeLoadContext } from "../../src/office/steps";
import { insertClaim } from "../../src/worktree/records";
import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  inRemote,
  notices,
  publish,
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

function profile(): RunProfile {
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

const exited = (code: number, stderr = ""): StepResult => ({
  outcome: "exited",
  code,
  signal: null,
  timedOut: false,
  stdout: { text: code === 0 ? "" : "seeding...\n", truncated: false },
  stderr: { text: stderr, truncated: false },
  warnings: [],
});

/** A step runner that records each request and answers per script (exit 0 by default). */
function fakeSteps(answers: Record<string, StepResult> = {}, onStep?: () => Promise<void>) {
  const requests: StepRequest[] = [];
  const runStep = async (request: StepRequest): Promise<StepResult> => {
    requests.push(request);
    await onStep?.();
    return answers[request.script] ?? exited(0);
  };
  return { requests, runStep };
}

/** Publishes the fixture with `.env` ignored, then creates the ignored `.env`. */
async function product(repo: TempRepoWithRemote): Promise<void> {
  writeFileSync(join(repo.dir, ".gitignore"), ".env\n");
  writeFileSync(join(repo.dir, "bun.lock"), "{}\n");
  await publish(repo);
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
  chmodSync(join(repo.dir, ".env"), 0o600);
}

interface Options {
  readonly disk?: DiskProbe;
  readonly steps?: ReturnType<typeof fakeSteps>;
  readonly profile?: RunProfile | null;
  readonly worktree?: Partial<SetupRequest["config"]["worktree"]>;
}

interface Harness {
  readonly s: ClaimSetup;
  readonly slots: SlotTable;
  /** `setupWorktree` for `claim`. */
  setup(claim: ClaimRecord, options?: Options): Promise<SetupOutcome>;
  /** `claimStory` with `setup` as its setup. */
  claim(key: ReturnType<ClaimSetup["key"]>, options?: Options): Promise<ClaimOutcome<SetupDone>>;
}

async function harness(repo: TempRepo): Promise<Harness> {
  const s = await claimSetup(repo);
  const slots = SlotTable.inState(join(repo.root, "state-dir"));
  const setup = (claim: ClaimRecord, options: Options = {}) =>
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
            ...options.worktree,
          },
          timeouts: OFFICE_DEFAULTS.timeouts,
          sandbox: OFFICE_DEFAULTS.sandbox,
        },
        profile: options.profile === undefined ? profile() : options.profile,
        host: { home: repo.home, uid: 501, env: { PATH: "/usr/bin:/bin", HOME: repo.home } },
      },
    );
  return {
    s,
    slots,
    setup,
    claim: (key, options = {}) =>
      claimStory<SetupDone>(s.deps(), {
        ...s.request(key),
        setup: (claim) => setup(claim, options),
      }),
  };
}

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

function skipped(outcome: ClaimOutcome<SetupDone>): ClaimSkip {
  if (outcome.ok) throw new Error("expected the claim to be skipped");
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

      const outcome = skipped(await h.claim(key, { steps, worktree: { post_create: [] } }));

      expect(steps.requests.map((r) => r.script)).toEqual(["install", "setup"]);
      expect(outcome.notice).toContain("setup (bun run setup) failed: exit 3");
      expect(outcome.notice).toContain("stays Ready");
      expect(outcome.log).toContain("database not reachable");
      expect(notices(h.s.office).map((n) => n.code)).toContain(SETUP_NOTICES.failed);
      await assertRolledBack(repo, h, key);
      // Nothing collides: the story can be claimed again.
      const again = await h.claim(key);
      expect(again.ok).toBe(true);
    }, FIXTURE);
  });

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
      expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(remoteTip);
      expect(releasedBranchFor(h.s.office, key, BRANCH_1)).not.toBeNull();
      expect(existsSync(wt)).toBe(false);
    }, FIXTURE);
  });
});
/** Releases the claim the way an amend would, keeping its branch for the story. */
function releaseNow(h: Harness, claim: ClaimRecord): void {
  h.s.office.immediate(() =>
    releaseClaim(h.s.office, claim.runId, {
      at: h.s.t.clock.now(),
      reason: "amend",
      keepBranch: true,
    }),
  );
}

describe("releases and restarts around setup", () => {
  for (const fails of [false, true]) {
    it(`a release during a setup that ${fails ? "fails" : "succeeds"} keeps the release, its row and the branch`, async () => {
      await withBareRemote(async (repo) => {
        await product(repo);
        const h = await harness(repo);
        const key = h.s.key();
        const steps = fakeSteps(fails ? { setup: exited(2, "broke\n") } : {});
        const request = {
          ...h.s.request(key),
          setup: async (claim: ClaimRecord) => {
            const outcome = await h.setup(claim, { steps, worktree: { post_create: [] } });
            releaseNow(h, claim);
            return outcome;
          },
        };

        const outcome = skipped(await claimStory<SetupDone>(h.s.deps(), request));

        expect(outcome.reason).toBe(fails ? "pickupCheckFailed" : "notRunnable");
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
  }

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
        "every port slot from 1 to 1 is taken",
      );
      // setupWorktree leaves the worktree; the claim's rollback removes it.
      expect(existsSync(claim.worktree)).toBe(true);
    }, FIXTURE);
  });
});
