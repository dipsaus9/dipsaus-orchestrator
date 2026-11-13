// A fixture backlog on disk for the tests of the one pass over the task files (DIPO-494): a
// `backlog/` folder with its configuration and one task file per task, written as Backlog.md 1.53
// writes them, with the front matter forms a hand edit can leave.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempRoot } from "@dipsaus-orchestrator/testkit";

export interface FileTask {
  readonly id: string;
  readonly status?: string;
  /** The text after `dependencies:` in the front matter; `[]` when not set. */
  readonly dependencies?: string;
  /** The branch as YAML text, quotes and escapes included; no field block when not set. */
  readonly branch?: string;
  /** The folder under `backlog/` the file goes into; `tasks` when not set. */
  readonly folder?: string;
  /** The whole file, when the test needs a form the fields cannot make. */
  readonly text?: string;
}

export const CONFIG = [
  'project_name: "fixture"',
  'default_status: "Refined"',
  'statuses: ["Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]',
  'task_prefix: "DIPO"',
  "",
].join("\n");

export function taskFileText(task: FileTask): string {
  if (task.text !== undefined) return task.text;
  const block =
    task.branch === undefined ? "" : ["", "```dipo", `branch: ${task.branch}`, "```"].join("\n");
  return [
    "---",
    `id: ${task.id}`,
    `title: Task ${task.id}`,
    `status: ${task.status ?? "Refined"}`,
    "assignee: []",
    "created_date: '2026-10-12 11:28'",
    "labels: []",
    `dependencies:${task.dependencies === undefined ? " []" : ` ${task.dependencies}`}`,
    "---",
    "",
    "## Description",
    "",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    `Story: As maintainer I want ${task.id} to work so that the gate has a task to read.${block}`,
    "<!-- SECTION:DESCRIPTION:END -->",
    "",
  ].join("\n");
}

/** Writes `tasks` into `dir`'s `backlog/` (and the configuration, unless `config` is false). */
export function writeBacklog(dir: string, tasks: readonly FileTask[], config = CONFIG): void {
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "backlog", "config.yml"), config);
  for (const task of tasks) {
    const folder = join(dir, "backlog", task.folder ?? "tasks");
    mkdirSync(folder, { recursive: true });
    const id = task.id.toLowerCase();
    writeFileSync(join(folder, `${id} - Task.md`), taskFileText(task));
  }
}

/** Runs `body` with a temporary directory holding `tasks` as a backlog, and removes it. */
export async function withBacklog<T>(
  tasks: readonly FileTask[],
  body: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tempRoot(), "task-files-"));
  try {
    writeBacklog(dir, tasks);
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
