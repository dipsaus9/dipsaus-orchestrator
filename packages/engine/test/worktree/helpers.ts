// Shared setup for the claim tests: the planning-lane setup (a temporary repository with the
// Backlog fixture, a migrated state database with one office, the office's git and the pinned
// Backlog CLI), plus claim dependencies, and a checkout a test makes by hand to change a story
// branch, since dipo makes no worktree for a story (DIPO-349).

import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { git, type TempRepo } from "@dipsaus-orchestrator/testkit";

import { type GitExec, type GitSettings, OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { EDIT_KIND, editKind, OfficeLane } from "../../src/backlog/lane";
import { type ClaimDeps, type ClaimRequest, hasLiveClaim } from "../../src/worktree";
import { type LaneSetup, laneSetup } from "../backlog/lane/helpers";

export {
  BACKLOG_FIXTURE,
  filesOf,
  inRemote,
  notices,
  otherClone,
  publish,
  pushStatusChange,
  subjects,
  taskFile,
} from "../backlog/lane/helpers";

export const TASK_1 = "TASK-1";
export const BRANCH_1 = "TASK-1/add-csv-export-command";
export const TASK_FILE_1 = "backlog/tasks/task-1 - Add-the-CSV-export-command.md";

export interface ClaimSetup extends LaneSetup {
  deps(overrides?: Partial<ClaimDeps>): ClaimDeps;
  request(key: StoryKey, overrides?: Partial<ClaimRequest>): ClaimRequest;
  key(): StoryKey;
  runId(): RunId;
}

export async function claimSetup(
  repo: TempRepo,
  settings: GitSettings = { remote: "origin", base: "main" },
): Promise<ClaimSetup> {
  const s = await laneSetup(repo, settings);
  return {
    ...s,
    deps: (overrides = {}) => ({
      officeId: s.office.officeId,
      office: s.office,
      git: s.git,
      cli: s.cli,
      clock: s.t.clock,
      ...overrides,
    }),
    request: (key, overrides = {}) => ({
      key,
      story: TASK_1,
      branch: BRANCH_1,
      runId: RunId.parse(s.t.ids.next("run")),
      ...overrides,
    }),
    key: () => StoryKey.parse(s.t.ids.next("sto")),
    runId: () => RunId.parse(s.t.ids.next("run")),
  };
}

/** Another `OfficeGit` on the same repository and office, with its own queue. */
export function secondGit(
  repo: TempRepo,
  s: LaneSetup,
  settings: GitSettings,
  exec: GitExec = spawnGitExec(systemSpawn),
): OfficeGit {
  return new OfficeGit({
    officeId: s.office.officeId as OfficeId,
    mainWorktree: realpathSync(repo.dir),
    commonDir: realpathSync(join(repo.dir, ".git")),
    settings,
    runner: { exec, env: repo.env, sleep: async () => {} },
    clock: s.t.clock,
  });
}

/**
 * Runs `fn` in a checkout of `branch` the test makes by hand under the repository's temp folder, as
 * the maintainer would, and removes it afterwards: dipo makes no worktree for a story (DIPO-349),
 * so a test that changes a story branch by hand commits there.
 */
export async function byHandOn<T>(
  repo: TempRepo,
  branch: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(repo.root, "hand-"));
  await git(repo.dir, repo.home, "worktree", "add", "--quiet", dir, branch);
  try {
    return await fn(dir);
  } finally {
    await git(repo.dir, repo.home, "worktree", "remove", "--force", dir);
  }
}

/** The planning lane of the setup's office, refusing stories with a live claim. */
export function laneOf(s: ClaimSetup): OfficeLane {
  return new OfficeLane({
    officeId: s.office.officeId,
    office: s.office,
    git: s.git,
    cli: s.cli,
    clock: s.t.clock,
    kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
    liveClaim: hasLiveClaim,
  });
}
