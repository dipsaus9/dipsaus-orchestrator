// The structural check of a backlog-only PR (0010) in CI: the `ready-gate` job of ci.yml runs it on
// a PR that the `changes` job found changes only `backlog/` (0016). It is the engine's own check
// (`checkBacklogPr`) over the engine's own diff (`collectPrDiff`), which views every changed task on
// both sides with the Backlog CLI in a temporary worktree of this script's, removed afterwards.
//
// CI has no dipo database, so two facts come from here instead:
// - the Ready gate decision of a task the PR makes Ready is the gate run on the head's backlog
//   (`checkReadyGate`): it passes only when the gate passes that very content;
// - no task has a live claim. Claims live in the maintainer's dipo database, and dipo checks them
//   with its own run of this check before it merges a backlog PR.
//
// Usage: bun scripts/check-backlog-pr.ts <base> <head> [repository]
//   <base> is the PR's base commit, <head> the commit to check (in CI the checked-out merge commit).
//   The diff runs from their merge base to <head>.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoryKey } from "../packages/contract/src/index";

import {
  checkBacklogPr,
  type CheckResult,
  type PrFacts,
} from "../packages/engine/src/backlog/pr/check";
import { collectPrDiff } from "../packages/engine/src/backlog/pr/diff";
import type { BacklogCli } from "../packages/engine/src/backlog/runner";
import { gateStoryFromView } from "../packages/engine/src/gate/input";
import { gateContentHash } from "../packages/engine/src/gate/store/hash";
import type { GitLocation } from "../packages/engine/src/git/hardened";
import type { GitSession } from "../packages/engine/src/git/office";
import {
  clockSleep,
  type GitStepRunner,
  runGitStep,
  runGitStepOk,
  spawnGitExec,
} from "../packages/engine/src/git/runner";
import { systemClock } from "../packages/engine/src/platform/clock";
import { systemSpawn } from "../packages/engine/src/platform/process";

import { checkReadyGate, REPO_BACKLOG_CLI } from "./check-ready-gate";

export interface BacklogPrCheckOptions {
  /** The repository checkout that holds both commits. */
  readonly repo: string;
  /** The PR's base commit. */
  readonly base: string;
  /** The commit to check. */
  readonly head: string;
  readonly cli: BacklogCli;
  /** Where the temporary worktree goes. */
  readonly tmp: string;
}

/** No repository hook runs: `worktree add` would run `post-checkout`. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...NO_HOOKS, "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** A git session over the engine's hardened steps, as the office git queue hands one out. */
function session(commonDir: string): GitSession {
  const runner: GitStepRunner = {
    exec: spawnGitExec(systemSpawn),
    env: process.env,
    sleep: clockSleep(systemClock),
  };
  return {
    repository: { kind: "repository", commonDir },
    step: (location, args, options) => runGitStep(runner, location, args, options),
    ok: (location, args, options) => runGitStepOk(runner, location, args, options),
  };
}

/** Runs the structural check on the PR from the merge base of `base` and `head` to `head`. */
export async function checkBacklogPrIn(options: BacklogPrCheckOptions): Promise<CheckResult> {
  const { repo, cli } = options;
  const head = git(repo, ["rev-parse", "--verify", `${options.head}^{commit}`]);
  const base = git(repo, ["merge-base", options.base, head]);
  const commonDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = mkdtempSync(join(options.tmp, "dipo-backlog-pr-"));
  const workTree = join(dir, "backlog");
  git(repo, ["worktree", "add", "--quiet", "--detach", workTree, head]);
  try {
    const worktree: Extract<GitLocation, { kind: "worktree" }> = {
      kind: "worktree",
      commonDir,
      gitDir: git(workTree, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      workTree,
    };
    const diff = await collectPrDiff({ git: session(commonDir), worktree, cli, base, head });
    // The worktree is back on `head`: the Ready gate decides on the content the diff shows.
    const gate = await checkReadyGate(workTree, cli);
    const passing: Record<string, string[]> = {};
    for (const change of diff.tasks) {
      const after = change.after;
      if (after.where !== "task" || !after.view.ok || !gate.passed.includes(change.id)) continue;
      const task = after.view.task;
      const story = gateStoryFromView(
        task,
        task.subtasks.map((sub) => sub.id),
      );
      passing[change.id] = [gateContentHash(story)];
    }
    const facts: PrFacts = {
      keys: Object.fromEntries(diff.tasks.map((change) => [change.id, change.id as StoryKey])),
      claimed: [],
      passing,
    };
    return checkBacklogPr(diff, facts);
  } finally {
    Bun.spawnSync(["git", ...NO_HOOKS, "-C", repo, "worktree", "remove", "--force", workTree], {
      stdout: "ignore",
      stderr: "ignore",
    });
    rmSync(dir, { recursive: true, force: true });
    Bun.spawnSync(["git", ...NO_HOOKS, "-C", repo, "worktree", "prune"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

if (import.meta.main) {
  const [base, head, repo = process.cwd()] = process.argv.slice(2);
  if (base === undefined || base === "" || head === undefined || head === "") {
    console.error("usage: bun scripts/check-backlog-pr.ts <base> <head> [repository]");
    process.exit(2);
  }
  try {
    const tmp = process.env["RUNNER_TEMP"] ?? tmpdir();
    const result = await checkBacklogPrIn({ repo, base, head, cli: REPO_BACKLOG_CLI, tmp });
    if (!result.passed) {
      for (const failure of result.failures) console.error(`[${failure.rule}] ${failure.message}`);
      console.error(`Structural check failed with ${result.failures.length} failure(s)`);
      process.exit(1);
    }
    console.log(`Structural check ok: ${result.touched.length} changed task(s)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
