// Checks every story whose status is Ready on the checked-out backlog against the Ready gate
// (DIPO-196, 0012), so a PR that leaves a story Ready which fails the gate fails CI with
// the gate's own messages, not only at `dipo run --dry-run`.
//
// Only the Ready stories are viewed through the CLI, none when no story is Ready (DIPO-494). The
// other active tasks, which R13, R14 and R19 read, come from one pass over the checkout's task
// files (`StoryStore.taskFacts`); a task file that does not parse fails the check. Each Ready
// story's input is built by the same function the daemon's read uses (`gateInputOf`), with the
// checked-out commit's file paths as the base tree R29 reads. The
// gate runs in `pickup` mode: a Ready story is checked by R01b (status Ready) and R02 to R30.
// `ready` mode would fail every Ready story at R01a, which wants Refined.
//
// A task may arrive at Ready only in a backlog-only PR, where the structural check runs (0010, 0012,
// DIPO-495). On a pull request (`GITHUB_BASE_REF`, as `check-backlog-pr.ts` reads it) the head is
// compared with the PR's base `origin/<base>`: when the PR changes any entry outside the Backlog
// files (a path other than a `.md` file under `backlog/` or `backlog/config.yml`, or an entry that
// is not a regular file, as the light path of ci.yml decides), every Ready story that is not a
// task at the merge base, a new task or a promoted draft, fails the check. A base that cannot be
// read fails it too.
//
// Usage: bun scripts/check-ready-gate.ts [repository]   (the repository defaults to the current directory)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadOfficeConfig } from "../packages/engine/src/config/load";
import { isBacklogFile, REGULAR_MODES } from "../packages/engine/src/backlog/pr/check";
import { parseRawDiff, taskOfPath } from "../packages/engine/src/backlog/pr/diff";
import type { BacklogCli } from "../packages/engine/src/backlog/runner";
import { backlogStoryStore } from "../packages/engine/src/backlog/store";
import { evaluateGate } from "../packages/engine/src/gate/evaluate";
import { gateConfigOf } from "../packages/engine/src/gate-decisions/feature";
import { gateInputOf, listTasks, otherTasks } from "../packages/engine/src/gate-decisions/read";
import { treePaths } from "../packages/engine/src/gate-decisions/tree";
import { loadRoleFiles, rosterOf } from "../packages/engine/src/roles/base";
import { ROLES_DIR } from "../packages/engine/src/roles/parse";
import { systemSpawn } from "../packages/engine/src/platform/process";
import { StoryParseError } from "../packages/engine/src/story-store/errors";
import { checkoutFiles } from "../packages/engine/src/story-store/folder";

const READY = "Ready";

/** The Backlog.md 1.53 devDependency of this repository, run with the same Bun. */
export const REPO_BACKLOG_CLI: BacklogCli = {
  spawn: systemSpawn,
  command: [process.execPath, join(import.meta.dir, "..", "node_modules", "backlog.md", "cli.js")],
};

/**
 * The file paths of the commit checked out in `repo`, listed as the daemon lists the base tree;
 * undefined when `repo` is not a git checkout. R29 then knows no base file, which can only add
 * failures: a bare test file name is covered only by a file Reference of that name.
 */
function treeFiles(repo: string): string[] | undefined {
  const args = ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"];
  const listed = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "ignore" });
  return listed.exitCode === 0 ? treePaths(listed.stdout.toString()) : undefined;
}

/** The role files of the checked-out commit, as the daemon reads them from the base (DIPO-471). */
function checkoutRoles(repo: string) {
  const dir = join(repo, ROLES_DIR);
  const names = (() => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      return [];
    }
  })();
  return loadRoleFiles(
    new Map(names.map((name) => [`${ROLES_DIR}/${name}`, readFileSync(join(dir, name), "utf8")])),
  );
}

/** Read-only git in `repo`, with no repository hook; throws with git's message when it fails. */
function gitIn(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

/**
 * Why each of the Ready stories `ready` may not be Ready in a PR from `base` to the checked-out
 * HEAD of `repo` (DIPO-495): none when every changed entry is a regular Backlog file (a backlog-only
 * PR, which the structural check covers), else one line for each Ready story that is no task at the
 * merge base, a new task or a draft promoted to Ready. Throws when `base` cannot be read.
 */
export function mixedPrReadyRefusals(
  repo: string,
  base: string,
  ready: readonly string[],
): string[] {
  const mergeBase = gitIn(repo, ["merge-base", `${base}^{commit}`, "HEAD"]).trim();
  const changed = parseRawDiff(
    gitIn(repo, ["diff", "--raw", "-z", "--no-renames", mergeBase, "HEAD"]),
  );
  const code = changed
    .filter(
      (entry) =>
        !isBacklogFile(entry.path) ||
        !REGULAR_MODES.includes(entry.from) ||
        !REGULAR_MODES.includes(entry.to),
    )
    .map((entry) => entry.path);
  if (code.length === 0) return [];
  const tasks = new Set(
    gitIn(repo, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--full-tree",
      mergeBase,
      "--",
      "backlog/tasks",
    ])
      .split("\0")
      .flatMap((path) => {
        const task = taskOfPath(path);
        return task?.where === "task" ? [task.id] : [];
      }),
  );
  const named = `${code.slice(0, 3).join(", ")}${code.length > 3 ? ` and ${code.length - 3} more` : ""}`;
  return ready
    .filter((id) => !tasks.has(id.toUpperCase()))
    .map(
      (id) =>
        `ready ${id} failed mixed-pr: ${id} is added at Ready, as a new task or a promoted draft, in a PR that also changes ${named}; a task may arrive at Ready only in a backlog-only PR (0012), so add it Refined here or in a PR of its own`,
    );
}

export interface ReadyGateReport {
  /** How many Ready stories were checked. */
  readonly checked: number;
  /** The ids of the Ready stories that passed, in list order. */
  readonly passed: readonly string[];
  /** Each failure as the gate's own `ready <ID> failed <rule>: <message>` line. */
  readonly failures: readonly string[];
  /**
   * Each warning (R29) as the gate's `ready <ID> warning <rule>: <message>` line, absent when none.
   * A warning is printed but never fails the check (DIPO-251).
   */
  readonly warnings?: readonly string[];
}

/**
 * Runs the Ready gate over every Ready story of the backlog in `repo`. Throws when the office
 * configuration is invalid, a Ready story's view does not parse, another task's file does not, a
 * CLI call fails, or the task list disagrees with its `--count` (DIPO-323), since nothing can be checked then: the gate never
 * runs on part of the backlog. With `base`, the PR's base, a Ready story a PR that also changes code
 * adds at Ready fails too (`mixedPrReadyRefusals`, DIPO-495).
 */
export async function checkReadyGate(
  repo: string,
  cli: BacklogCli,
  options: { readonly base?: string } = {},
): Promise<ReadyGateReport> {
  const loaded = await loadOfficeConfig(repo);
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join("\n"));
  const config = gateConfigOf(loaded.config);
  const stories = backlogStoryStore(cli);
  // The task files first: a file that does not parse fails with its own name, where the list
  // would only come up one short.
  const others = await otherTasks(stories, repo);
  const entries = await listTasks(stories, repo);
  const milestones = await stories.milestones(repo);
  const folders = await stories.storyFolders(checkoutFiles(repo));
  const files = treeFiles(repo);
  const roles = checkoutRoles(repo);
  const roster = rosterOf(roles.roles);
  const ready = entries.filter((entry) => entry.group === READY);
  const failures: string[] = [];
  const warnings: string[] = roles.problems.map((problem) => `role file ${problem}`);
  const passed: string[] = [];
  for (const entry of ready) {
    const view = await stories.view(repo, entry.id).catch((error: unknown) => {
      if (!(error instanceof StoryParseError)) throw error;
      throw new Error(`${entry.id} is Ready but its Backlog view does not parse`);
    });
    const input = gateInputOf(view, others, milestones, folders, config, files);
    const result = evaluateGate({ ...input, roster }, "pickup");
    if (result.passed) passed.push(entry.id);
    failures.push(...result.failures.map((failure) => failure.message));
    warnings.push(...(result.warnings ?? []).map((warning) => warning.message));
  }
  if (options.base !== undefined) {
    failures.push(
      ...mixedPrReadyRefusals(
        repo,
        options.base,
        ready.map((entry) => entry.id),
      ),
    );
  }
  return {
    checked: ready.length,
    passed,
    failures,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

if (import.meta.main) {
  try {
    // On a pull request, the PR's base: a Ready task a PR that also changes code adds fails.
    const baseRef = process.env["GITHUB_BASE_REF"] ?? "";
    const report = await checkReadyGate(
      process.argv[2] ?? process.cwd(),
      REPO_BACKLOG_CLI,
      baseRef === "" ? {} : { base: `refs/remotes/origin/${baseRef}` },
    );
    for (const warning of report.warnings ?? []) console.warn(warning);
    if (report.failures.length > 0) {
      for (const failure of report.failures) console.error(failure);
      console.error(
        `Ready gate failed for ${report.failures.length} rule(s) of ${report.checked} Ready stories`,
      );
      process.exit(1);
    }
    console.log(`Ready gate ok: ${report.checked} Ready stories checked`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
