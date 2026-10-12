// Where the CLI runs (0006 decision 4, DIPO-27): the current directory, whether a person is at the
// terminal, and the git repository around a path. The CLI resolves an office from `--office`, else
// from the `office.json` marker in the repository's `<git-common-dir>/dipo/` (0007 section 2). The
// daemon still decides whether that office is registered and whether this main worktree is its
// registered path (`from`), so an unopened copy carrying the original's marker is not that office.
// The repository is resolved with the contract's `resolveRepositoryWith`, the same logic as the
// engine's.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  type GitOutput,
  OfficeId,
  type RepositoryLocation,
  resolveRepositoryWith,
} from "@dipsaus-orchestrator/contract";

export type { RepositoryLocation };

export interface Workspace {
  readonly cwd: string;
  /** True when stdin and stdout are a terminal: only then does the CLI ask (0006 question 2). */
  readonly interactive: boolean;
  /** Asks one question on the terminal and returns the answer line. */
  ask(question: string): Promise<string>;
  /** The repository around `path` (canonical paths), or null outside git. */
  locate(path: string): Promise<RepositoryLocation | null>;
  /** The office id in `<commonDir>/dipo/office.json`, or null without a valid marker. */
  readOfficeId(commonDir: string): OfficeId | null;
  /** True when the main worktree holds `backlog/config.yml`. */
  isBacklogProject(mainWorktree: string): boolean;
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): Promise<GitOutput> {
  const child = Bun.spawn(
    ["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args],
    {
      cwd,
      ...(env === undefined ? {} : { env: { ...env } }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, stdout, stderr };
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The repository around `path`; `env` replaces the environment git runs with (tests). */
export async function locateRepository(
  path: string,
  env?: Readonly<Record<string, string>>,
): Promise<RepositoryLocation | null> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const resolved = await resolveRepositoryWith({
    git: (args) => git(path, args, env),
    canonical: canonicalPath,
  });
  return resolved.ok ? resolved.location : null;
}

export function readOfficeId(commonDir: string): OfficeId | null {
  try {
    const marker = JSON.parse(readFileSync(join(commonDir, "dipo", "office.json"), "utf8")) as {
      officeId?: unknown;
    };
    const parsed = OfficeId.safeParse(marker.officeId);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isBacklogProject(mainWorktree: string): boolean {
  return existsSync(join(mainWorktree, "backlog", "config.yml"));
}

export function systemWorkspace(): Workspace {
  return {
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await prompt.question(question);
      } finally {
        prompt.close();
      }
    },
    locate: (path) => locateRepository(path),
    readOfficeId,
    isBacklogProject,
  };
}

/** `path` made absolute against the workspace's current directory. */
export function absolute(workspace: Workspace, path: string): string {
  return resolve(workspace.cwd, path);
}
