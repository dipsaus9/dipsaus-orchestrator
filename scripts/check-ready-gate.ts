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
// Usage: bun scripts/check-ready-gate.ts [repository]   (the repository defaults to the current directory)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadOfficeConfig } from "../packages/engine/src/config/load";
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
 * runs on part of the backlog.
 */
export async function checkReadyGate(repo: string, cli: BacklogCli): Promise<ReadyGateReport> {
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
  return {
    checked: ready.length,
    passed,
    failures,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

if (import.meta.main) {
  try {
    const report = await checkReadyGate(process.argv[2] ?? process.cwd(), REPO_BACKLOG_CLI);
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
