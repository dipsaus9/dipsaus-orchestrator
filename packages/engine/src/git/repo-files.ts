// Read-only file facts of a repository checkout for the scan (0013 section 3). It lists files
// and asks git which paths it ignores. It never runs a repository script: every git call is a step
// of the git module's runner (`git/runner.ts`), hardened as every engine git call is (no hooks, no
// fsmonitor), with the deadline of every engine git step, so a scan never holds the office git
// queue item it runs in.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { clockSleep, runGitStep, spawnGitExec } from "./runner";

import { systemClock } from "../platform/clock";
import { systemSpawn } from "../platform/process";

export interface RepoFiles {
  /** Repo-relative POSIX paths of tracked and untracked, not ignored files. */
  listFiles(): Promise<string[]>;
  /** The text of a repo-relative file, or undefined when it is missing or not a file. */
  readText(path: string): Promise<string | undefined>;
  /** True when a repo-relative path exists as a file. Never reads its contents. */
  exists(path: string): Promise<boolean>;
  /** The subset of repo-relative paths that git ignores. Never reads their contents. */
  ignored(paths: readonly string[]): Promise<Set<string>>;
}

export type RepoFilesOptions = {
  /** Environment for git; defaults to the daemon's environment. */
  env?: Record<string, string | undefined>;
  /** The clock each git call's deadline runs on; the system clock by default. */
  clock?: Clock;
  /** How git starts; the system's spawn by default. */
  spawn?: Spawn;
};

// The scan finds the repository from its root, so its git runs without recorded paths (location
// `none`).

function inside(root: string, path: string): string {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith("../")) {
    throw new Error(`path escapes the repository: ${path}`);
  }
  return join(root, clean);
}

interface Steps {
  readonly exec: ReturnType<typeof spawnGitExec>;
  readonly env: Record<string, string | undefined>;
  readonly sleep: ReturnType<typeof clockSleep>;
  readonly clock: Clock;
}

async function runGit(
  root: string,
  args: string[],
  steps: Steps,
  stdin?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runGitStep(
    steps,
    { kind: "none", cwd: root },
    args,
    stdin === undefined ? {} : { stdin },
  );
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

const splitZ = (text: string) => text.split("\0").filter((entry) => entry !== "");

/** File facts of the git work tree at `root`. */
export function createRepoFiles(root: string, options: RepoFilesOptions = {}): RepoFiles {
  const clock = options.clock ?? systemClock;
  const git: Steps = {
    exec: spawnGitExec(options.spawn ?? systemSpawn),
    env: options.env ?? process.env,
    sleep: clockSleep(clock),
    clock,
  };
  return {
    async listFiles() {
      const result = await runGit(
        root,
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        git,
      );
      if (result.exitCode !== 0) {
        throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`);
      }
      return [...new Set(splitZ(result.stdout))].toSorted();
    },
    async readText(path) {
      try {
        return await readFile(inside(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
    async exists(path) {
      try {
        return (await stat(inside(root, path))).isFile();
      } catch {
        return false;
      }
    },
    async ignored(paths) {
      if (paths.length === 0) return new Set();
      for (const path of paths) inside(root, path);
      const result = await runGit(
        root,
        ["check-ignore", "--stdin", "-z"],
        git,
        paths.map((path) => `${path}\0`).join(""),
      );
      // Exit 1 means none of the paths is ignored.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`git check-ignore failed in ${root}: ${result.stderr.trim()}`);
      }
      return new Set(splitZ(result.stdout));
    },
  };
}
