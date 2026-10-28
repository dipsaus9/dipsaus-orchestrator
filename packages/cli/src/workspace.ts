// Where the CLI runs (0006 decision 4, DIPO-27): the current directory, whether a person is at the
// terminal, and the git repository around a path. The CLI resolves an office from `--office`, else
// from the `office.json` marker in the repository's `<git-common-dir>/dipo/` (0007 section 2). The
// daemon still decides whether that office is registered and whether this main worktree is its
// registered path (`from`), so an unopened copy carrying the original's marker is not that office.
// The repository is resolved with the contract's `resolveRepositoryWith`, the same logic as the
// engine's.
//
// This lookup is the one git call outside the engine's git module (0010): the CLI never imports the
// engine (0004). It only reads (`rev-parse`, `worktree list`), and it is hardened with the same
// definition as every engine git call (the contract's `git-hardening.ts`: no system config, hooks
// and fsmonitor off, no pager, no prompt, the inherited config and location variables dropped),
// with a deadline: past `LOOKUP_DEADLINE_MS` git is killed and the lookup fails.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { systemClock } from "@dipsaus-orchestrator/client/node";
import {
  type Clock,
  type GitOutput,
  hardenedGitEnv,
  hardenedGitOptions,
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

/** How long one git call of the lookup may take before it is killed. */
export const LOOKUP_DEADLINE_MS = 10_000;

/** The command line of one lookup call: the hardened options, then the read. */
export function lookupGitCommand(args: readonly string[]): [string, ...string[]] {
  return ["git", ...hardenedGitOptions(), ...args];
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock,
): Promise<GitOutput> {
  const child = Bun.spawn(lookupGitCommand(args), {
    cwd,
    env: hardenedGitEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, LOOKUP_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      return {
        ok: false,
        stdout: "",
        stderr: `git ${args.join(" ")} was killed after ${LOOKUP_DEADLINE_MS / 1000} s`,
      };
    }
    return { ok: code === 0, stdout, stderr };
  } finally {
    clock.clearTimeout(timer);
  }
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The repository around `path`. `env` is the environment git starts from (the process's by
 * default) before it is hardened; `clock` runs the deadline (tests).
 */
export async function locateRepository(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  clock: Clock = systemClock,
): Promise<RepositoryLocation | null> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const resolved = await resolveRepositoryWith({
    git: (args) => git(path, args, env, clock),
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
