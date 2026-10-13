// Shared setup for the office init tests. `fileBacklog` is a fast stand-in for the Backlog CLI that
// works on the files of the directory it runs in, for the few commands init uses: `config get`,
// `config set`, `task list --plain`, `task view --plain` and `task edit -s`. The real CLI takes
// about 0.3 s a call, so the local tests use this and the CI tests the pinned CLI (0017).
// `oldOffice` turns the Backlog fixture into an office from before dipo: the statuses `To Do`,
// `In Progress` and `Done`, `default_status: "To Do"` and settings dipo has to change.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../../../src/backlog/runner";
import type { OfficeDirectory } from "../../../src/commands/offices";
import type { OfficeHandle } from "../../../src/db/office";
import { scriptedSpawn, type ScriptedReply, viewOutput } from "../../backlog/helpers";

const CONFIG_KEYS: Readonly<Record<string, string>> = {
  statuses: "statuses",
  defaultStatus: "default_status",
  checkActiveBranches: "check_active_branches",
  remoteOperations: "remote_operations",
  autoCommit: "auto_commit",
};

function configPath(cwd: string): string {
  return join(cwd, "backlog", "config.yml");
}

function configValue(cwd: string, key: string): string {
  const line = readFileSync(configPath(cwd), "utf8")
    .split("\n")
    .find((text) => text.startsWith(`${key}:`));
  return (line ?? "").slice(key.length + 1).trim();
}

function statusesOf(cwd: string): string[] {
  return JSON.parse(configValue(cwd, "statuses")) as string[];
}

interface TaskFile {
  readonly path: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

function tasks(cwd: string): TaskFile[] {
  const dir = join(cwd, "backlog", "tasks");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      const field = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(text)?.[1] ?? "";
      return { path, id: field("id"), title: field("title"), status: field("status") };
    });
}

/** The status line of a task file rewritten. */
export function setTaskStatus(cwd: string, id: string, status: string): void {
  const task = tasks(cwd).find((entry) => entry.id === id);
  if (task === undefined) throw new Error(`no task ${id} in ${cwd}`);
  const text = readFileSync(task.path, "utf8");
  writeFileSync(task.path, text.replace(/^status: .*$/m, `status: ${status}`));
}

function reply(cwd: string, args: readonly string[]): ScriptedReply {
  const [group, sub, ...rest] = args;
  if (group === "config" && sub === "get") {
    const key = CONFIG_KEYS[rest[0] ?? ""];
    if (key === undefined) return { code: 1, stderr: "unknown key" };
    if (key === "statuses") return { stdout: `${statusesOf(cwd).join(", ")}\n` };
    return { stdout: `${configValue(cwd, key).replaceAll('"', "")}\n` };
  }
  if (group === "config" && sub === "set") {
    const key = CONFIG_KEYS[rest[0] ?? ""];
    const value = rest[1] ?? "";
    if (key === undefined || key === "statuses") return { code: 1, stderr: "refused" };
    const text = readFileSync(configPath(cwd), "utf8");
    const written = key === "default_status" ? JSON.stringify(value) : value;
    writeFileSync(
      configPath(cwd),
      text.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${written}`),
    );
    return { stdout: `Set ${rest[0]} = ${value}\n` };
  }
  if (group === "task" && sub === "list") {
    const byStatus = new Map<string, TaskFile[]>();
    for (const task of tasks(cwd)) {
      byStatus.set(task.status, [...(byStatus.get(task.status) ?? []), task]);
    }
    const lines: string[] = [];
    for (const [status, list] of byStatus) {
      lines.push(`${status}:`, ...list.map((task) => `  ${task.id} - ${task.title}`), "");
    }
    return { stdout: lines.join("\n") };
  }
  if (group === "task" && sub === "view") {
    const task = tasks(cwd).find((entry) => entry.id === rest[0]);
    if (task === undefined) return { code: 1, stderr: "Task not found" };
    return {
      stdout: viewOutput(task.id, "").replace("Status: ○ Ready", `Status: ○ ${task.status}`),
    };
  }
  if (group === "task" && sub === "edit") {
    const [id, flag, status] = rest;
    if (flag !== "-s" || id === undefined || status === undefined) {
      return { code: 1, stderr: "unsupported edit" };
    }
    if (!statusesOf(cwd).includes(status)) {
      return { code: 1, stderr: `Invalid status: ${status}` };
    }
    setTaskStatus(cwd, id, status);
    return { stdout: `Updated task ${id}\n` };
  }
  return { code: 1, stderr: `the fake CLI does not know ${args.join(" ")}` };
}

/** A Backlog CLI on the files of the directory it runs in; `calls` logs each command. */
export function fileBacklog(): { readonly cli: BacklogCli; readonly calls: string[] } {
  const calls: string[] = [];
  let cwd = "";
  const stub = scriptedSpawn((args) => {
    calls.push(args.join(" "));
    return reply(cwd, args);
  });
  return {
    calls,
    cli: {
      spawn: (options) => {
        cwd = options.cwd ?? "";
        return stub.spawn(options);
      },
    },
  };
}

/** The `backlog/config.yml` of an office from before dipo. */
export const OLD_CONFIG = [
  'project_name: "dipo-fixture"',
  'default_status: "To Do"',
  'statuses: ["To Do", "In Progress", "Done"]',
  "labels: []",
  "date_format: yyyy-mm-dd",
  "remote_operations: false",
  "auto_commit: false",
  "check_active_branches: false",
  "active_branch_days: 30",
  'task_prefix: "task"',
  "",
].join("\n");

/**
 * Rewrites the fixture in `dir` into an office from before dipo: TASK-1 and TASK-2 `To Do`, TASK-3
 * `Done`.
 */
export function oldOffice(dir: string): void {
  writeFileSync(configPath(dir), OLD_CONFIG);
  setTaskStatus(dir, "TASK-1", "To Do");
  setTaskStatus(dir, "TASK-2", "To Do");
  setTaskStatus(dir, "TASK-3", "Done");
}

/** An office directory with one loaded office. */
export function oneOffice(office: OfficeHandle): OfficeDirectory {
  return {
    load: async (id: OfficeId) =>
      id === office.officeId
        ? { ok: true, office }
        : {
            ok: false,
            error: { code: "office.unknown", message: `no office ${id}`, retryable: false },
          },
    get: (id: OfficeId) => (id === office.officeId ? office : undefined),
  };
}
