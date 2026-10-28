// Where an office lives (0007 section 2): the office path is the main worktree, the first entry of
// `git worktree list --porcelain`, so a linked worktree opens the same office; the office's own
// directory is `<git-common-dir>/dipo/`, with the common directory from
// `git rev-parse --path-format=absolute --git-common-dir`. Git runs through the injected `Spawn` as
// a step of the git module's runner (`git/runner.ts`), hardened as every engine git call is: no
// hooks, no fsmonitor, no system config, and the deadline of every engine git step.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type Clock,
  mainWorktreeOf,
  type RepositoryLocation,
  resolveRepositoryWith,
  type Spawn,
} from "@dipsaus-orchestrator/contract";

import { clockSleep, runGitStep, spawnGitExec } from "../git/runner";
import { systemClock } from "../platform/clock";
import { isNetworkFsType, mountFor, type MountReader, readSystemMounts } from "../platform/sqlite";

/** The Backlog.md project file that makes a repository a project (0006 decision 4). */
export const BACKLOG_CONFIG = join("backlog", "config.yml");

/** How the office module runs git. */
export interface GitRunner {
  readonly spawn: Spawn;
  /** The git executable; the daemon passes the path it resolved from its `PATH`. */
  readonly git?: string;
  /** The complete environment for git; tests pass an isolated one. */
  readonly env?: Readonly<Record<string, string>>;
  /** The clock each call's deadline runs on; the system clock by default. */
  readonly clock?: Clock;
}

/** One discovery step: no recorded paths yet, so git finds the repository from `cwd`. */
function runGit(runner: GitRunner, cwd: string, args: readonly string[]) {
  const clock = runner.clock ?? systemClock;
  const steps = {
    exec: spawnGitExec(runner.spawn, runner.git),
    env: runner.env ?? process.env,
    sleep: clockSleep(clock),
    clock,
  };
  return runGitStep(steps, { kind: "none", cwd }, args);
}

/** A repository as the office sees it: the main worktree (the office path) and the common dir. */
export type Repository = RepositoryLocation;

export type ResolveResult =
  | { readonly ok: true; readonly repository: Repository }
  | {
      readonly ok: false;
      readonly reason: "missing" | "not-git" | "bare";
      readonly detail: string;
    };

/** The canonical form of an existing path (symlinks resolved); the path itself otherwise. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export { mainWorktreeOf };

/**
 * Resolves `path` (any worktree of a repository, or a directory in one) to its office location,
 * with the contract's `resolveRepositoryWith`, which the CLI uses too.
 */
export async function resolveRepository(runner: GitRunner, path: string): Promise<ResolveResult> {
  if (!existsSync(path)) return { ok: false, reason: "missing", detail: `${path} does not exist` };
  if (!statSync(path).isDirectory()) {
    return { ok: false, reason: "not-git", detail: `${path} is not a directory` };
  }
  const resolved = await resolveRepositoryWith({
    git: async (args) => {
      const result = await runGit(runner, path, args);
      return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
    },
    canonical: canonicalPath,
  });
  return resolved.ok ? { ok: true, repository: resolved.location } : resolved;
}

/** True when the main worktree holds a Backlog.md project (`backlog/config.yml`). */
export function isBacklogProject(mainWorktree: string): boolean {
  return existsSync(join(mainWorktree, BACKLOG_CONFIG));
}

/**
 * The network filesystem type `path` sits on, or null on a local disk (0007 section 2). An
 * unreadable mount table counts as local: this only decides whether to warn.
 */
export async function networkFsType(
  path: string,
  readMounts: MountReader = readSystemMounts,
): Promise<string | null> {
  let mounts: Awaited<ReturnType<MountReader>>;
  try {
    mounts = await readMounts();
  } catch {
    return null;
  }
  const mount = mounts === null ? undefined : mountFor(path, mounts);
  return mount !== undefined && isNetworkFsType(mount.fsType) ? mount.fsType : null;
}
