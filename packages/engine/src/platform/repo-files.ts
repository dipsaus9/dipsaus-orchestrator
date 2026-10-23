// Read-only file facts of a repository checkout for the scan (0013 section 3). It lists files
// and asks git which paths it ignores. It never runs a repository script: the git calls disable
// `core.fsmonitor` and `core.hooksPath`, so git runs no repository-chosen command. Each git call
// has the deadline of every engine git step (DIPO-314, `GIT_STEP_DEADLINE_MS`): git runs in its
// own process group, and past the deadline the group is killed and the call fails with
// `git.timedOut`, so a scan never holds the office git queue item it runs in.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { Clock, Signal } from "@dipsaus-orchestrator/contract";

import { hardenedArgs, hardenedEnv } from "../git/hardened";
import { GIT_STEP_DEADLINE_MS, GitError } from "../git/runner";

import { systemClock } from "./clock";
import { timedOutText, withDeadline } from "./deadline";
import { signalGroup } from "./process";

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
};

// Every scan git call is hardened like any engine git call (0008 section 2, DIPO-31). The scan finds
// the repository from its root, so it runs without recorded paths (location `none`).

function inside(root: string, path: string): string {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith("../")) {
    throw new Error(`path escapes the repository: ${path}`);
  }
  return join(root, clean);
}

async function runGit(
  root: string,
  args: string[],
  options: { readonly env: Record<string, string | undefined>; readonly clock: Clock },
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const location = { kind: "none", cwd: root } as const;
  const proc = Bun.spawn(["git", ...hardenedArgs(location, args)], {
    cwd: root,
    env: hardenedEnv(options.env, location),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const child = {
    kill: (signal?: Signal) => proc.kill(signal),
    killGroup: (signal: Signal) => void signalGroup(proc.pid, signal),
  };
  const [stdout, stderr, exitCode] = await withDeadline(
    child,
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
    {
      clock: options.clock,
      deadlineMs: GIT_STEP_DEADLINE_MS,
      timedOut: () =>
        new GitError(
          "git.timedOut",
          `${timedOutText(["git", ...args], GIT_STEP_DEADLINE_MS)}.`,
          false,
          {
            args: [...args],
            timeoutMs: GIT_STEP_DEADLINE_MS,
          },
        ),
    },
  );
  return { exitCode, stdout, stderr };
}

const splitZ = (text: string) => text.split("\0").filter((entry) => entry !== "");

/** File facts of the git work tree at `root`. */
export function createRepoFiles(root: string, options: RepoFilesOptions = {}): RepoFiles {
  const git = { env: options.env ?? process.env, clock: options.clock ?? systemClock };
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
