// Where an office lives (0007 section 2): the office path is the main worktree, the first entry of
// `git worktree list --porcelain`, so a linked worktree opens the same office; the office's own
// directory is `<git-common-dir>/dipo/`, with the common directory from
// `git rev-parse --path-format=absolute --git-common-dir`. Git runs through the injected `Spawn`
// and never runs a repository-chosen command (`core.fsmonitor` off, as in the scan).

import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import { isNetworkFsType, mountFor, type MountReader, readSystemMounts } from "../platform/sqlite";

/** The Backlog.md project file that makes a repository a project (0006 decision 4). */
export const BACKLOG_CONFIG = join("backlog", "config.yml");

const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];

/** How the office module runs git. */
export interface GitRunner {
  readonly spawn: Spawn;
  /** The git executable; the daemon passes the path it resolved from its `PATH`. */
  readonly git?: string;
  /** The complete environment for git; tests pass an isolated one. */
  readonly env?: Readonly<Record<string, string>>;
}

interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<GitResult> {
  const child = runner.spawn({
    cmd: [runner.git ?? "git", ...GIT_SAFE, ...args],
    cwd,
    ...(runner.env === undefined ? {} : { env: runner.env }),
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code: exit.code, stdout, stderr };
}

/** A repository as the office sees it. */
export interface Repository {
  /** The main worktree, canonical (symlinks resolved): the office path. */
  readonly mainWorktree: string;
  /** `<git-common-dir>`, canonical. */
  readonly commonDir: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly repository: Repository }
  | {
      readonly ok: false;
      readonly reason: "missing" | "not-git" | "bare";
      readonly detail: string;
    };

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The main worktree from `git worktree list --porcelain`: the first `worktree` record. */
export function mainWorktreeOf(porcelain: string): { path: string; bare: boolean } | null {
  const records = porcelain.split("\n\n");
  const first = records[0]?.split("\n") ?? [];
  const line = first.find((entry) => entry.startsWith("worktree "));
  if (line === undefined) return null;
  return { path: line.slice("worktree ".length), bare: first.includes("bare") };
}

/** Resolves `path` (any worktree of a repository, or a directory in one) to its office location. */
export async function resolveRepository(runner: GitRunner, path: string): Promise<ResolveResult> {
  if (!existsSync(path)) return { ok: false, reason: "missing", detail: `${path} does not exist` };
  if (!statSync(path).isDirectory()) {
    return { ok: false, reason: "not-git", detail: `${path} is not a directory` };
  }
  const common = await runGit(runner, path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common.code !== 0) {
    return { ok: false, reason: "not-git", detail: common.stderr.trim() || "not a git repository" };
  }
  const list = await runGit(runner, path, ["worktree", "list", "--porcelain"]);
  const main = list.code === 0 ? mainWorktreeOf(list.stdout) : null;
  if (main === null) {
    return { ok: false, reason: "not-git", detail: list.stderr.trim() || "no worktree listed" };
  }
  if (main.bare) {
    return { ok: false, reason: "bare", detail: `${main.path} is a bare repository` };
  }
  const commonDir = canonical(common.stdout.trim());
  let mainWorktree = canonical(main.path);
  if (mainWorktree === commonDir) {
    // A repository made with `--separate-git-dir` lists its git directory as the main worktree;
    // from the main worktree itself `--show-toplevel` names it. A linked worktree cannot.
    const own = await runGit(runner, path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--show-toplevel",
    ]);
    const [gitDir, top] = own.stdout.trim().split("\n");
    if (own.code !== 0 || gitDir === undefined || top === undefined) {
      return { ok: false, reason: "not-git", detail: "cannot find the main worktree" };
    }
    if (canonical(gitDir) !== commonDir) {
      return {
        ok: false,
        reason: "not-git",
        detail: `its git directory ${commonDir} is separate from the main worktree; open the main worktree instead`,
      };
    }
    mainWorktree = canonical(top);
  }
  return { ok: true, repository: { mainWorktree, commonDir } };
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
