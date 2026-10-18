// The gate's inputs read through the Backlog CLI in one worktree (the office's `_base`): the story
// (`task view`, or `draft view` for a `DRAFT-n` id), every active task with its dependencies and
// branch (from the mirror when the caller has it for this commit, DIPO-180, else `task list` and
// one `task view` each) and the milestones (`milestone list`). The office configuration comes from
// the caller.

import {
  BacklogParseError,
  parseList,
  parseView,
  type PlainTask,
  plainLines,
} from "../../backlog/plain";
import { type BacklogCli, BacklogCommandError, runBacklog } from "../../backlog/runner";
import { openDependencies } from "../../run/select";
import { isProvisionalId } from "../../stories/keys";
import { mapLimited, VIEW_CONCURRENCY } from "../../stories/read";
import { gateStoryFromView, gateTaskFromView } from "../input";
import type { GateConfig, GateDependency, GateInput, GateTask } from "../types";

/** The dependencies of `task` that are not Done, with the status the CLI read for each (DIPO-179). */
export function waitingOnOf(task: PlainTask): GateDependency[] {
  const open = openDependencies(task);
  return task.dependencies
    .filter((dependency) => open.includes(dependency.id))
    .map((dependency) => ({
      id: dependency.id,
      ...(dependency.state === "resolved" && dependency.status !== undefined
        ? { status: dependency.status }
        : {}),
    }));
}

/** One `  <id>: <name> (<done>/<total> done)` line of `milestone list --plain`. */
const MILESTONE_LINE = /^ {2}(\S+): (.*?)(?: \(\d+\/\d+ done\))?$/;

/** The ids and names of every milestone `milestone list --show-completed --plain` printed. */
export function parseMilestones(output: string): string[] {
  const names: string[] = [];
  for (const line of plainLines(output)) {
    const match = MILESTONE_LINE.exec(line);
    if (match === null) continue;
    const [, id, name] = match;
    if (id !== undefined) names.push(id);
    if (name !== undefined && name !== "") names.push(name);
  }
  return names;
}

async function view(cli: BacklogCli, cwd: string, id: string) {
  const kind = isProvisionalId(id) ? "draft" : "task";
  const { stdout } = await runBacklog(cli, cwd, [kind, "view", id, "--plain"]);
  return parseView(stdout);
}

/** The story's own view reported `not found`: it is not on this worktree's checkout. */
export class StoryNotFoundError extends Error {
  constructor(readonly story: string) {
    super(`${story} is not in the Backlog.md project on this checkout.`);
    this.name = "StoryNotFoundError";
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the view failed because Backlog.md 1.53.x has no such story: a stderr line
 * `Task <ID> not found.` (exit 1) or `Draft <ID> not found.` (exit 0), naming this very id. Any
 * other failure, such as a shell's `command not found`, is not.
 */
export function isStoryNotFound(error: BacklogCommandError, story: string): boolean {
  const line = new RegExp(`^(Task|Draft) ${escapeRegExp(story)} not found\\.`, "i");
  return error.stderr.split("\n").some((text) => line.test(text));
}

/** Every listed task through its own view: the slow read, one CLI call per task. */
async function viewActiveTasks(
  cli: BacklogCli,
  cwd: string,
  target: PlainTask,
): Promise<GateTask[]> {
  const listed = parseList((await runBacklog(cli, cwd, ["task", "list", "--plain"])).stdout);
  return mapLimited(listed.entries, VIEW_CONCURRENCY, async (entry) => {
    if (entry.id === target.id) return gateTaskFromView(target);
    try {
      return gateTaskFromView(await view(cli, cwd, entry.id));
    } catch (error) {
      if (!(error instanceof BacklogParseError)) throw error;
      // A task whose view does not parse still counts as active, without dependencies or branch.
      return { id: entry.id, dependencies: [] };
    }
  });
}

/**
 * Reads the gate input of `story` in the worktree `cwd`. With `others`, the active tasks the
 * mirror holds for this very commit (`cachedGateTasks`), only the story and the milestones go
 * through the CLI: two calls however many tasks there are. Without it, every listed task is viewed.
 * Throws `StoryNotFoundError` when the story is not there, `BacklogCommandError` or
 * `BacklogRefusedError` when the CLI fails otherwise, and `BacklogParseError` when an output does
 * not parse.
 */
export async function readGateInput(
  cli: BacklogCli,
  cwd: string,
  story: string,
  config: GateConfig,
  others?: readonly GateTask[],
): Promise<GateInput> {
  let target;
  try {
    target = await view(cli, cwd, story);
  } catch (error) {
    if (error instanceof BacklogCommandError && isStoryNotFound(error, story)) {
      throw new StoryNotFoundError(story);
    }
    throw error;
  }
  const activeTasks =
    others !== undefined
      ? others.map((task) => (task.id === target.id ? gateTaskFromView(target) : task))
      : await viewActiveTasks(cli, cwd, target);
  const milestones = parseMilestones(
    (await runBacklog(cli, cwd, ["milestone", "list", "--show-completed", "--plain"])).stdout,
  );
  return {
    story: {
      ...gateStoryFromView(
        target,
        target.subtasks.map((task) => task.id),
      ),
      waitingOn: waitingOnOf(target),
    },
    activeTasks,
    milestones,
    config,
  };
}
