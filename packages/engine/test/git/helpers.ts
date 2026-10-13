// Shared setup for the office git tests (DIPO-31): an office git over a temporary repository, a
// first commit pushed to the bare `origin`, and a push from a second clone. Used by
// office-git.test.ts and its CI-only sibling office-git.ci.test.ts.

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, ManualClock, type TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import { type GitSettings, OfficeGit, type Sleep, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

export const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;

export interface Repo {
  readonly dir: string;
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

export type SettingsOverride = { base?: string | undefined; worktreeRoot?: string | undefined };

/** Settings with base `main` unless the override names `base`, even as undefined. */
export function gitSettingsOf(override: SettingsOverride): GitSettings {
  const base = "base" in override ? override.base : "main";
  return {
    remote: "origin",
    ...(base === undefined ? {} : { base }),
    ...(override.worktreeRoot === undefined ? {} : { worktreeRoot: override.worktreeRoot }),
  };
}

export function officeGit(
  repo: Repo,
  settings: SettingsOverride = {},
  sleep: Sleep = async () => {},
): OfficeGit {
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: realpathSync(repo.dir),
    commonDir: realpathSync(join(repo.dir, ".git")),
    settings: gitSettingsOf(settings),
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep },
    clock: new ManualClock(),
  });
}

/** A repository with one commit on `main`, pushed to its bare `origin`. */
export async function published(repo: TempRepoWithRemote): Promise<string> {
  writeFileSync(join(repo.dir, "README.md"), "hello\n");
  const sha = await repo.commitAll("first");
  await repo.git("push", "--quiet", "origin", "main");
  return sha;
}

/** Commits `file` in a second clone of `origin` and pushes it; returns the new commit. */
export async function pushFromElsewhere(repo: TempRepoWithRemote, file: string): Promise<string> {
  const other = join(repo.root, "other");
  if (!existsSync(other)) await git(repo.root, repo.home, "clone", "--quiet", repo.remote, other);
  else await git(other, repo.home, "pull", "--quiet", "--ff-only");
  writeFileSync(join(other, file), `${file}\n`);
  await git(other, repo.home, "add", file);
  await git(other, repo.home, "commit", "--quiet", "-m", file);
  await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
  return (await git(other, repo.home, "rev-parse", "HEAD")).trim();
}
