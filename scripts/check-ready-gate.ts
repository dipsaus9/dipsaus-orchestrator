// Checks every story whose status is Ready on the checked-out backlog against the Ready gate
// (DIPO-196, 0012 section 3), so a PR that leaves a story Ready which fails the gate fails CI with
// the gate's own messages, not only at `dipo run --dry-run`.
//
// Every listed task is viewed once: the views of the Ready stories and the other tasks both come
// from those reads, and each Ready story's input is built by the same function the daemon's read
// uses (`gateInputOf`), with the checked-out commit's file paths as the base tree R29 reads. The
// gate runs in `pickup` mode: a Ready story is checked by R01b (status Ready) and R02 to R30.
// `ready` mode would fail every Ready story at R01a, which wants Refined.
//
// Usage: bun scripts/check-ready-gate.ts [repository]   (the repository defaults to the current directory)

import { join } from "node:path";

import { loadOfficeConfig } from "../packages/engine/src/config/load";
import { type BacklogCli, runBacklog } from "../packages/engine/src/backlog/runner";
import { evaluateGate } from "../packages/engine/src/gate/evaluate";
import { gateConfigOf } from "../packages/engine/src/gate/store/feature";
import {
  gateInputOf,
  gateTasksOf,
  listTasks,
  parseMilestones,
  viewListedTasks,
} from "../packages/engine/src/gate/store/read";
import { treePaths } from "../packages/engine/src/gate/store/tree";
import { systemSpawn } from "../packages/engine/src/platform/process";

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

export interface ReadyGateReport {
  /** How many Ready stories were checked. */
  readonly checked: number;
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
 * configuration is invalid or a Ready story's view does not parse, since nothing can be checked then.
 */
export async function checkReadyGate(repo: string, cli: BacklogCli): Promise<ReadyGateReport> {
  const loaded = await loadOfficeConfig(repo);
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join("\n"));
  const config = gateConfigOf(loaded.config);
  const entries = await listTasks(cli, repo);
  const views = await viewListedTasks(
    cli,
    repo,
    entries.map((entry) => entry.id),
  );
  const milestones = parseMilestones(
    (await runBacklog(cli, repo, ["milestone", "list", "--show-completed", "--plain"])).stdout,
  );
  const others = gateTasksOf(views);
  const files = treeFiles(repo);
  const ready = entries.filter((entry) => entry.group === READY);
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const entry of ready) {
    const view = views.get(entry.id);
    if (view === undefined) {
      throw new Error(`${entry.id} is Ready but its Backlog view does not parse`);
    }
    const input = gateInputOf(view, others, milestones, config, files);
    const result = evaluateGate(input, "pickup");
    failures.push(...result.failures.map((failure) => failure.message));
    warnings.push(...(result.warnings ?? []).map((warning) => warning.message));
  }
  return { checked: ready.length, failures, ...(warnings.length === 0 ? {} : { warnings }) };
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
