// CI only (0017 section 1; DIPO-39): a real claim (DIPO-38) against a bare remote and the pinned
// Backlog CLI, with setup inside it running real sandboxed steps through `dipo daemon sandbox-exec`
// (DIPO-37), before the claim commit and the push.
// The fixture product has no dependencies, so `bun install --frozen-lockfile` needs no network.
// A passing setup copies the ignored `.env` and runs install and `setup` with the run
// environment; a failing `setup` script removes the worktree and deletes the branch, nothing reaches
// the remote, the story stays Ready on origin/main and can be claimed again.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import { runSandboxedStep } from "../../src/sandbox/step";
import type { CommandSpec, Resolution, RunProfile } from "../../src/scan/detect";
import {
  claimStory,
  type ClaimOutcome,
  findClaim,
  hasLiveClaim,
  liveClaims,
  type SetupDone,
  setupWorktree,
  SlotTable,
} from "../../src/worktree";
import { CI, stepDeps } from "../sandbox/helpers";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  inRemote,
  publish,
  TASK_FILE_1,
} from "./helpers";

const TIMEOUT_MS = 120_000;
const SECRET = "CI-DEV-SECRET-3c1d";

const resolved = (...commands: string[][]): Resolution<CommandSpec> => ({
  status: "resolved",
  value: { commands, cwd: "." },
  source: "standard",
  confidence: "high",
  evidence: "package.json",
});

const PROFILE: RunProfile = {
  fingerprint: "f",
  toolchain: {
    packageManager: { status: "unresolved" },
    runtimeVersion: { status: "unresolved" },
    workspaces: [],
  },
  capabilities: {
    install: resolved(["bun", "install", "--frozen-lockfile"]),
    setup: resolved(["bun", "run", "setup"]),
    dev: { status: "unresolved" },
    test: { status: "unresolved" },
    lint: { status: "unresolved" },
    typecheck: { status: "unresolved" },
    verify: resolved(["bun", "run", "verify"]),
    build: { status: "unresolved" },
  },
  extraScripts: [],
  envFiles: [],
  devPorts: [],
  conformance: { level: "partial", deviations: [] },
  runRefusal: null,
};

/** Publishes the Backlog fixture plus a dependency-free product whose `setup` runs `script`. */
async function product(repo: TempRepoWithRemote, script: string): Promise<void> {
  writeFileSync(
    join(repo.dir, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, scripts: { setup: script } }, null, 2)}\n`,
  );
  writeFileSync(join(repo.dir, ".gitignore"), ".env\nnode_modules/\nsetup-ran.txt\n");
  const lock = await repo.run(["bun", "install"]);
  if (lock.exitCode !== 0) throw new Error(`bun install failed: ${lock.stderr}`);
  await publish(repo);
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
}

function claimed(outcome: ClaimOutcome) {
  if (!outcome.ok) throw new Error(`expected a claim, got ${outcome.reason}: ${outcome.notice}`);
  return outcome.claim;
}

/** Claims TASK-1 with setup through the real sandbox as its `setup`. */
async function claimWithSetup(
  repo: TempRepoWithRemote,
  s: ClaimSetup,
): Promise<ClaimOutcome<SetupDone>> {
  const state = join(repo.root, "dipo-state");
  const runtime = join(repo.root, "dipo-run");
  mkdirSync(state, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const deps = stepDeps();
  return claimStory<SetupDone>(s.deps(), {
    ...s.request(s.key()),
    setup: (claim) =>
      setupWorktree(
        {
          ...s.deps(),
          slots: SlotTable.inState(state),
          runStep: (request) => runSandboxedStep(deps, request),
        },
        {
          claim,
          config: {
            worktree: {
              ...OFFICE_DEFAULTS.worktree,
              files: [{ path: ".env", mode: "copy", required: true }],
            },
            timeouts: { ...OFFICE_DEFAULTS.timeouts, scriptMinutes: { install: 2, setup: 2 } },
            sandbox: OFFICE_DEFAULTS.sandbox,
          },
          profile: PROFILE,
          host: {
            home: repo.home,
            uid: process.getuid?.() ?? 0,
            env: { ...process.env, HOME: repo.home, DIPO_HOME: state, DIPO_RUNTIME_DIR: runtime },
          },
        },
      ),
  });
}

if (CI) {
  describe("setting up a claimed worktree with the real sandbox", () => {
    it(
      "copies the ignored .env and runs install and setup with the run environment, then commits and pushes",
      async () => {
        await withBareRemote(
          async (repo) => {
            await product(repo, 'echo "$DIPO_SLOT $PORT $DIPO_STORY" > setup-ran.txt');
            const s = await claimSetup(repo);
            const outcome = await claimWithSetup(repo, s);
            if (!outcome.ok) throw new Error(`${outcome.notice}\n${outcome.log}`);
            const setup = outcome.setup as SetupDone;
            const worktree = outcome.claim.worktree;
            expect(readFileSync(join(worktree, ".env"), "utf8")).toContain(SECRET);
            expect(readFileSync(join(worktree, "setup-ran.txt"), "utf8").trim()).toBe("1  TASK-1");
            expect(setup.log.join("\n")).not.toContain(SECRET);
            expect(outcome.pushed).toBe(true);
          },
          { fixture: BACKLOG_FIXTURE },
        );
      },
      TIMEOUT_MS,
    );

    it(
      "a failing setup script rolls back the claim before anything is pushed and leaves the story Ready",
      async () => {
        await withBareRemote(
          async (repo) => {
            await product(repo, "echo setup-broke >&2; exit 3");
            const s = await claimSetup(repo);
            const outcome = await claimWithSetup(repo, s);
            if (outcome.ok) throw new Error("expected setup to fail");

            expect(outcome.reason).toBe("pickupCheckFailed");
            expect(outcome.log).toContain("setup-broke");
            expect(existsSync(join(s.git.worktreeRoot(), "TASK-1"))).toBe(false);
            const local = await repo.run([
              "git",
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${BRANCH_1}`,
            ]);
            expect(local.exitCode).not.toBe(0);
            // No remote branch exists: nothing was pushed.
            expect((await inRemote(repo, "branch", "--list", BRANCH_1)).trim()).toBe("");
            const heads = await repo.git("ls-remote", "--heads", "origin");
            expect(heads).not.toContain(BRANCH_1);
            // The story stays Ready on origin/main.
            expect(await repo.git("show", `origin/main:${TASK_FILE_1}`)).toContain("status: Ready");
            expect(liveClaims(s.office)).toEqual([]);

            // The story can be claimed again: nothing is left that collides.
            const again = claimed(await claimStory(s.deps(), s.request(s.key())));
            expect(hasLiveClaim(s.office, again.key)).toBe(true);
            expect(findClaim(s.office, again.runId)?.branch).toBe(BRANCH_1);
          },
          { fixture: BACKLOG_FIXTURE },
        );
      },
      TIMEOUT_MS,
    );
  });
}
