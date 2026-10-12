// Read-only file facts of a repository checkout for the scan (0013 section 3). It lists files
// and asks git which paths it ignores. It never runs a repository script: the git calls disable
// `core.fsmonitor` and `core.hooksPath`, so git runs no repository-chosen command.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { hardenedArgs, hardenedEnv } from "../git/hardened";

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
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const location = { kind: "none", cwd: root } as const;
  const proc = Bun.spawn(["git", ...hardenedArgs(location, args)], {
    cwd: root,
    env: hardenedEnv(env, location),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const splitZ = (text: string) => text.split("\0").filter((entry) => entry !== "");

/** File facts of the git work tree at `root`. */
export function createRepoFiles(root: string, options: RepoFilesOptions = {}): RepoFiles {
  const env = options.env ?? process.env;
  return {
    async listFiles() {
      const result = await runGit(
        root,
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        env,
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
        env,
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
