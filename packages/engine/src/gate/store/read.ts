// The gate's inputs read through the Backlog CLI in one worktree (the office's `_base`): the story
// (`task view`, or `draft view` for a `DRAFT-n` id), every active task with its dependencies and
// branch (`task list` and one `task view` each) and the milestones (`milestone list`). The office
// configuration comes from the caller.

import { BacklogParseError, parseList, parseView, plainLines } from "../../backlog/plain";
import { type BacklogCli, BacklogCommandError, runBacklog } from "../../backlog/runner";
import { isProvisionalId } from "../../stories/keys";
import { mapLimited, VIEW_CONCURRENCY } from "../../stories/read";
import { gateStoryFromView, gateTaskFromView } from "../input";
import type { GateConfig, GateInput } from "../types";

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

function isNotFound(error: BacklogCommandError): boolean {
  return /\bnot found\b/i.test(`${error.stderr}\n${error.stdout}`);
}

/**
 * Reads the gate input of `story` in the worktree `cwd`. Throws `StoryNotFoundError` when the
 * story is not there, `BacklogCommandError` or `BacklogRefusedError` when the CLI fails otherwise,
 * and `BacklogParseError` when an output does not parse.
 */
export async function readGateInput(
  cli: BacklogCli,
  cwd: string,
  story: string,
  config: GateConfig,
): Promise<GateInput> {
  let target;
  try {
    target = await view(cli, cwd, story);
  } catch (error) {
    if (error instanceof BacklogCommandError && isNotFound(error)) {
      throw new StoryNotFoundError(story);
    }
    throw error;
  }
  const listed = parseList((await runBacklog(cli, cwd, ["task", "list", "--plain"])).stdout);
  const activeTasks = await mapLimited(listed.entries, VIEW_CONCURRENCY, async (entry) => {
    if (entry.id === target.id) return gateTaskFromView(target);
    try {
      return gateTaskFromView(await view(cli, cwd, entry.id));
    } catch (error) {
      if (!(error instanceof BacklogParseError)) throw error;
      // A task whose view does not parse still counts as active, without dependencies or branch.
      return { id: entry.id, dependencies: [] };
    }
  });
  const milestones = parseMilestones(
    (await runBacklog(cli, cwd, ["milestone", "list", "--show-completed", "--plain"])).stdout,
  );
  return {
    story: gateStoryFromView(
      target,
      target.subtasks.map((task) => task.id),
    ),
    activeTasks,
    milestones,
    config,
  };
}
