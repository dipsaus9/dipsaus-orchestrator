// Where an office lives (0007 section 2): the office path is the main worktree, the first entry of
// `git worktree list --porcelain`, so a linked worktree opens the same office; the office's own
// directory is `<git-common-dir>/dipo/`, with the common directory from
// `git rev-parse --path-format=absolute --git-common-dir`. Git runs through the injected `Spawn`
// hardened as every engine git call is (`git/hardened.ts`): no hooks, no fsmonitor, no system config.
// Each call has the deadline of every engine git step (DIPO-314, `GIT_STEP_DEADLINE_MS`) and fails
// with `git.timedOut` past it.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type Clock,
  mainWorktreeOf,
  type RepositoryLocation,
  resolveRepositoryWith,
  type Spawn,
} from "@dipsaus-orchestrator/contract";

import { hardenedArgs, hardenedEnv } from "../git/hardened";
import { GIT_STEP_DEADLINE_MS, gitTimedOut } from "../git/runner";
import { systemClock } from "../platform/clock";
import { trackEngineCall, withDeadline } from "../platform/deadline";
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

interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<GitResult> {
  // Discovery: no recorded paths yet, so git finds the repository from `cwd`.
  const location = { kind: "none", cwd } as const;
  const child = runner.spawn({
    cmd: [runner.git ?? "git", ...hardenedArgs(location, args)],
    cwd,
    env: hardenedEnv(runner.env ?? process.env, location),
    detached: true,
  });
  trackEngineCall(child);
  const [stdout, stderr, exit] = await withDeadline(
    child,
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    {
      clock: runner.clock ?? systemClock,
      deadlineMs: GIT_STEP_DEADLINE_MS,
      timedOut: () => gitTimedOut(args, GIT_STEP_DEADLINE_MS),
    },
  );
  return { code: exit.code, stdout, stderr };
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
