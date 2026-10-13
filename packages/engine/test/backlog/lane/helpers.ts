// Shared setup for the planning-lane tests: a temporary repository holding the Backlog fixture
// project (pushed to a bare `origin` when the test has one), a migrated state database with one
// office, the office's git with real hardened calls, and the pinned Backlog CLI whose calls are
// logged together with whether they ran inside an office git queue item.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, type Spawn, StoryKey } from "@dipsaus-orchestrator/contract";
import { git, type TempRepo, type TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import { OfficeLane, type LaneOpKind, editKind, EDIT_KIND } from "../../../src/backlog/lane";
import type { BacklogCli } from "../../../src/backlog/runner";
import { readLogState } from "../../../src/changelog/log";
import type { OfficeHandle } from "../../../src/db/office";
import { OfficeGit, spawnGitExec } from "../../../src/git";
import { systemSpawn } from "../../../src/platform/process";
import { addOffice, openTestState, type TestState } from "../../commands/helpers";
import { BACKLOG_CLI } from "../helpers";

export { BACKLOG_FIXTURE } from "../helpers";

export interface LaneSetup {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly cli: BacklogCli;
  readonly kinds: Map<string, LaneOpKind>;
  /** Every CLI call (`backlog` arguments joined by spaces), plus markers tests push. */
  readonly log: string[];
  /** Called on each CLI call before it starts. */
  readonly hooks: { onCli?: (args: readonly string[]) => void };
  lane(): OfficeLane;
}

/** Commits the fixture and, with a remote, pushes `main`. */
export async function publish(repo: TempRepo | TempRepoWithRemote): Promise<void> {
  await repo.commitAll("fixture");
  if ("remote" in repo) await repo.git("push", "--quiet", "origin", "main");
}

export async function laneSetup(repo: TempRepo): Promise<LaneSetup> {
  const t = await openTestState(join(repo.root, "state-dir"));
  const office = addOffice(t);
  const officeGit = new OfficeGit({
    officeId: office.officeId as OfficeId,
    mainWorktree: realpathSync(repo.dir),
    commonDir: realpathSync(join(repo.dir, ".git")),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
    clock: t.clock,
  });
  const log: string[] = [];
  const hooks: LaneSetup["hooks"] = {};
  const spawn: Spawn = (options) => {
    const args = options.cmd.slice(BACKLOG_CLI.length);
    log.push(`cli ${args.join(" ")}`);
    hooks.onCli?.(args);
    return systemSpawn(options);
  };
  const setup: LaneSetup = {
    t,
    office,
    git: officeGit,
    cli: { spawn, command: BACKLOG_CLI, env: repo.env },
    kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
    log,
    hooks,
    lane: () =>
      new OfficeLane({
        officeId: office.officeId,
        office,
        git: officeGit,
        cli: setup.cli,
        clock: t.clock,
        kinds: setup.kinds,
      }),
  };
  return setup;
}

export function storyKey(s: LaneSetup): StoryKey {
  return StoryKey.parse(s.t.ids.next("sto"));
}

/** The fixture task file of `id` in `dir`. */
export function taskFile(dir: string, id: string): string {
  const name = {
    "TASK-1": "task-1 - Add-the-CSV-export-command.md",
    "TASK-2": "task-2 - Rename-the-export-setting.md",
    "TASK-3": "task-3 - Export-stories-as-JSON.md",
  }[id];
  if (name === undefined) throw new Error(`no fixture task ${id}`);
  return join(dir, "backlog", "tasks", name);
}

/** A second clone of `origin` (created on first use, else pulled). */
export async function otherClone(repo: TempRepoWithRemote): Promise<string> {
  const other = join(repo.root, "other");
  if (!existsSync(other)) {
    await git(repo.root, repo.home, "clone", "--quiet", repo.remote, other);
  } else {
    await git(other, repo.home, "checkout", "--quiet", "main");
    await git(other, repo.home, "pull", "--quiet", "--ff-only");
  }
  await git(other, repo.home, "fetch", "--quiet", "origin");
  return other;
}

/** Squash-merges `branch` into `main` on the remote, as the host's squash merge does. */
export async function squashMergeOnRemote(repo: TempRepoWithRemote, branch: string): Promise<void> {
  const other = await otherClone(repo);
  await git(other, repo.home, "merge", "--quiet", "--squash", `origin/${branch}`);
  await git(other, repo.home, "commit", "--quiet", "-m", `backlog PR ${branch}`);
  await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
}

/** Rewrites a task's status line on the remote's `main`, as another change would. */
export async function pushStatusChange(
  repo: TempRepoWithRemote,
  changes: Readonly<Record<string, string>>,
): Promise<void> {
  const other = await otherClone(repo);
  for (const [id, status] of Object.entries(changes)) {
    const file = taskFile(other, id);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^status: .*$/m, `status: ${status}`));
  }
  await git(other, repo.home, "commit", "--quiet", "-am", "change statuses elsewhere");
  await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
}

/** `git <args>` in the bare remote. */
export function inRemote(repo: TempRepoWithRemote, ...args: string[]): Promise<string> {
  return git(repo.remote, repo.home, ...args);
}

/** Commit subjects of `ref` not on `base`, oldest first. */
export async function subjects(
  cwd: string,
  home: string,
  ref: string,
  base: string,
): Promise<string[]> {
  const out = await git(cwd, home, "log", "--reverse", "--format=%s", ref, `^${base}`);
  return out.split("\n").filter((line) => line !== "");
}

/** Files a commit changed. */
export async function filesOf(cwd: string, home: string, commit: string): Promise<string[]> {
  const out = await git(cwd, home, "diff-tree", "--no-commit-id", "--name-only", "-r", commit);
  return out.split("\n").filter((line) => line !== "");
}

interface NoticeRow {
  type: string;
  key: string | null;
  delta: string;
}

/** The `engine.notice` entries of the office's change log. */
export function notices(
  office: OfficeHandle,
): { key: string | null; level: string; code: string; text: string }[] {
  readLogState(office);
  return office
    .all<NoticeRow>(
      "select type, key, delta from change_log where office_id = $office_id and type = 'engine.notice' order by seq",
    )
    .map((row) => ({
      key: row.key,
      ...(JSON.parse(row.delta) as { level: string; code: string; text: string }),
    }));
}
