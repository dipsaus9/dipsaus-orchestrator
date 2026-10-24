// Isolated temporary git repositories for integration tests (0017 section 3). The maintainer's
// global git config, hooks, identity and signing never reach a test: every git call testkit
// makes, and every command run through `TempRepo.run`, gets the environment from `isolatedEnv`.

import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { cleanEnv } from "./env";
import { makeTempDir, removeTempDir } from "./temp";

export const GIT_IDENTITY = { name: "Dipo Test", email: "test@dipo.invalid" } as const;
/** Fixed author and committer date, so commit hashes are the same on every run. */
export const GIT_DATE = "2026-01-01T00:00:00Z";

/** Config passed through `GIT_CONFIG_*` so it also reaches git run by other tools. */
const GIT_CONFIG: readonly [string, string][] = [
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

/**
 * Config written into each temporary repository: the identity and no signing, as the four
 * `git config` calls would write it, appended in one write (DIPO-225: four git starts saved for
 * every temporary repository of the suite).
 */
const REPO_CONFIG = [
  "[user]",
  `\tname = ${GIT_IDENTITY.name}`,
  `\temail = ${GIT_IDENTITY.email}`,
  "[commit]",
  "\tgpgsign = false",
  "[tag]",
  "\tgpgsign = false",
  "",
].join("\n");

/**
 * The environment for git and tools that call git: the cleaned environment (no ANTHROPIC_*,
 * CLAUDE_*, GH_*), no inherited GIT_* variables, no global or system config, `HOME` and
 * `XDG_CONFIG_HOME` under `home`, a fixed identity and dates, and no signing.
 */
export function isolatedEnv(home: string): Record<string, string> {
  const env = cleanEnv();
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  Object.assign(env, {
    HOME: home,
    // Engine git drops GIT_CONFIG_GLOBAL (DIPO-31), so the global config it finds must be in `home`.
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_DATE: GIT_DATE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
  });
  GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export type RunResult = { exitCode: number; stdout: string; stderr: string };

export class CommandError extends Error {
  constructor(
    readonly cmd: readonly string[],
    readonly result: RunResult,
  ) {
    super(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = "CommandError";
  }
}

/** Runs `cmd` without a shell and collects its output; never throws on a non-zero exit. */
export async function runCommand(
  cmd: readonly [string, ...string[]],
  options: { cwd: string; env: Record<string, string> },
): Promise<RunResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
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

/** Runs git in `cwd` with the isolated environment for `home`; throws on a non-zero exit. */
export async function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const cmd: [string, ...string[]] = ["git", ...args];
  const result = await runCommand(cmd, { cwd, env: isolatedEnv(home) });
  if (result.exitCode !== 0) throw new CommandError(cmd, result);
  return result.stdout;
}

/** A fixture tree: a directory to copy, or relative paths mapped to file contents. */
export type FixtureTree = string | Readonly<Record<string, string>>;

export function applyFixture(dir: string, fixture: FixtureTree): void {
  if (typeof fixture === "string") {
    cpSync(fixture, dir, { recursive: true });
    return;
  }
  for (const [path, content] of Object.entries(fixture)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export type TempRepo = {
  /** The `dipo-XXXXXX` temp directory holding `repo`, `home` and any bare remote. */
  readonly root: string;
  /** The work tree, initialised on branch `main`. */
  readonly dir: string;
  /** `HOME` for every command run against this repository. */
  readonly home: string;
  /** The isolated environment used for every command. */
  readonly env: Record<string, string>;
  /** Runs git in the work tree; throws `CommandError` on a non-zero exit, returns stdout. */
  git(...args: string[]): Promise<string>;
  /** Runs any command in the work tree with the isolated environment; never throws on exit. */
  run(cmd: readonly [string, ...string[]], cwd?: string): Promise<RunResult>;
  /** Stages everything and commits it with `message`; returns the new commit hash. */
  commitAll(message: string): Promise<string>;
};

export type TempRepoOptions = { fixture?: FixtureTree };

/**
 * Creates `dipo-XXXXXX` under `$DIPO_TMP` (else `/tmp`), runs `git init -b main` in its `repo`
 * directory, applies the fixture tree (uncommitted), runs `fn`, and removes the whole temp
 * directory in a `finally` unless `DIPO_TEST_KEEP=1`.
 */
export async function withTempRepo<T>(
  fn: (repo: TempRepo) => T | Promise<T>,
  options: TempRepoOptions = {},
): Promise<T> {
  const root = makeTempDir();
  try {
    const dir = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(dir);
    mkdirSync(home);
    const env = isolatedEnv(home);
    await git(dir, home, "init", "--quiet", "-b", "main");
    // The identity and no signing also in the repository's own config: a tool that gets only
    // PATH and HOME, like the Backlog CLI (DIPO-270), commits with them too, on any machine.
    appendFileSync(join(dir, ".git", "config"), REPO_CONFIG);
    if (options.fixture !== undefined) applyFixture(dir, options.fixture);
    const repo: TempRepo = {
      root,
      dir,
      home,
      env,
      git: (...args) => git(dir, home, ...args),
      run: (cmd, cwd = dir) => runCommand(cmd, { cwd, env }),
      commitAll: async (message) => {
        await git(dir, home, "add", "--all");
        await git(dir, home, "commit", "--quiet", "--allow-empty", "-m", message);
        return (await git(dir, home, "rev-parse", "HEAD")).trim();
      },
    };
    return await fn(repo);
  } finally {
    removeTempDir(root);
  }
}

export type TempRepoWithRemote = TempRepo & {
  /** Path of the bare repository registered as `origin`. */
  readonly remote: string;
};

/**
 * A `withTempRepo` repository whose `origin` is a bare repository in the same temp directory,
 * so push and fetch are real with no network (0017 section 3).
 */
export async function withBareRemote<T>(
  fn: (repo: TempRepoWithRemote) => T | Promise<T>,
  options: TempRepoOptions = {},
): Promise<T> {
  return withTempRepo(async (repo) => {
    const remote = join(repo.root, "origin.git");
    await git(repo.root, repo.home, "init", "--quiet", "--bare", "-b", "main", remote);
    await repo.git("remote", "add", "origin", remote);
    return fn({ ...repo, remote });
  }, options);
}
