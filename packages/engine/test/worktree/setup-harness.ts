// Shared setup for the worktree setup tests (DIPO-39): a claim setup, a slot table, a run profile,
// and the fixture product with an ignored `.env`. Setup runs no step on the Mac (DIPO-240).
// Used by setup.test.ts and its CI-only sibling setup-claim.ci.test.ts.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TempRepo, TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import { WORKTREE_ADD_CONFIG } from "../../src/git/hardened";
import { readWorktreeSnapshot } from "../../src/git/snapshot";
import type { DiskProbe } from "../../src/platform/disk";
import type { CommandSpec, Resolution, RunProfile } from "../../src/scan/detect";
import {
  type ClaimOutcome,
  type ClaimRecord,
  type ClaimSkip,
  claimStory,
  findClaim,
  releaseClaim,
  type SetupDone,
  type SetupOutcome,
  type SetupRequest,
  setupWorktree,
  SlotTable,
} from "../../src/worktree";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { insertClaim } from "../../src/worktree/records";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  publish,
  ROOMY,
  TASK_1,
} from "./helpers";

export const SECRET = "DEV-SECRET-77b2e0";
export const FIXTURE = { fixture: BACKLOG_FIXTURE };
export const ONE_GB: DiskProbe = { freeBytes: () => Promise.resolve(1_000_000_000) };

const resolved = (...commands: string[][]): Resolution<CommandSpec> => ({
  status: "resolved",
  value: { commands, cwd: "." },
  source: "standard",
  confidence: "high",
  evidence: "package.json",
});

/** The run profile the harness sets up with: install, setup and verify resolved. */
export function runProfile(): RunProfile {
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

/** Publishes the fixture with `.env` ignored, then creates the ignored `.env`. */
export async function product(repo: TempRepoWithRemote): Promise<void> {
  writeFileSync(join(repo.dir, ".gitignore"), ".env\n");
  writeFileSync(join(repo.dir, "bun.lock"), "{}\n");
  await publish(repo);
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
  chmodSync(join(repo.dir, ".env"), 0o600);
}

export interface Options {
  readonly disk?: DiskProbe;
  readonly profile?: RunProfile | null;
  readonly worktree?: Partial<SetupRequest["config"]["worktree"]>;
}

export interface Harness {
  readonly s: ClaimSetup;
  readonly slots: SlotTable;
  /** `setupWorktree` for `claim`. */
  setup(claim: ClaimRecord, options?: Options): Promise<SetupOutcome>;
  /** `claimStory` with `setup` as its setup. */
  claim(key: ReturnType<ClaimSetup["key"]>, options?: Options): Promise<ClaimOutcome<SetupDone>>;
}

export async function harness(repo: TempRepo): Promise<Harness> {
  const s = await claimSetup(repo);
  const slots = SlotTable.inState(join(repo.root, "state-dir"));
  const setup = (claim: ClaimRecord, options: Options = {}) =>
    setupWorktree(
      {
        ...s.deps({ disk: options.disk ?? ROOMY }),
        slots,
        localSettings: CLAUDE_LOCAL_SETTINGS,
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
        },
        profile: options.profile === undefined ? runProfile() : options.profile,
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

export function skipped(outcome: ClaimOutcome<SetupDone>): ClaimSkip {
  if (outcome.ok) throw new Error("expected the claim to be skipped");
  return outcome;
}

/** The state `claimStory` leaves before setup, made with plain git (no Backlog CLI). */
export async function localClaim(repo: TempRepo, s: ClaimSetup): Promise<ClaimRecord> {
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

/** Releases the claim the way an amend would, keeping its branch for the story. */
export function releaseNow(h: Harness, claim: ClaimRecord): void {
  h.s.office.immediate(() =>
    releaseClaim(h.s.office, claim.runId, {
      at: h.s.t.clock.now(),
      reason: "amend",
      keepBranch: true,
    }),
  );
}
