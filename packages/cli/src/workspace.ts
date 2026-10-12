// Where the CLI runs (0006 decision 4, DIPO-27): the current directory, whether a person is at the
// terminal, and the git repository around a path. The CLI resolves an office from `--office`, else
// from the `office.json` marker in the repository's `<git-common-dir>/dipo/` (0007 section 2); the
// daemon still decides whether that office is registered.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { OfficeId } from "@dipsaus-orchestrator/contract";

/** A repository as the office sees it: its main worktree and its common git directory. */
export interface RepositoryLocation {
  readonly mainWorktree: string;
  readonly commonDir: string;
}

export interface Workspace {
  readonly cwd: string;
  /** True when stdin and stdout are a terminal: only then does the CLI ask (0006 question 2). */
  readonly interactive: boolean;
  /** Asks one question on the terminal and returns the answer line. */
  ask(question: string): Promise<string>;
  /** The repository around `path`, or null outside git. */
  locate(path: string): Promise<RepositoryLocation | null>;
  /** The office id in `<commonDir>/dipo/office.json`, or null without a valid marker. */
  readOfficeId(commonDir: string): OfficeId | null;
  /** True when the main worktree holds `backlog/config.yml`. */
  isBacklogProject(mainWorktree: string): boolean;
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? text : null;
}

/** The first `worktree` record of `git worktree list --porcelain`. */
function mainWorktreeOf(porcelain: string): string | null {
  const first = porcelain.split("\n\n")[0]?.split("\n") ?? [];
  const line = first.find((entry) => entry.startsWith("worktree "));
  return line === undefined ? null : line.slice("worktree ".length);
}

export async function locateRepository(path: string): Promise<RepositoryLocation | null> {
  if (!existsSync(path)) return null;
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const list = await git(path, ["worktree", "list", "--porcelain"]);
  const main = list === null ? null : mainWorktreeOf(list);
  if (common === null || main === null) return null;
  return { mainWorktree: main, commonDir: common.trim() };
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
    locate: locateRepository,
    readOfficeId,
    isBacklogProject: (mainWorktree) => existsSync(join(mainWorktree, "backlog", "config.yml")),
  };
}

/** `path` made absolute against the workspace's current directory. */
export function absolute(workspace: Workspace, path: string): string {
  return resolve(workspace.cwd, path);
}
