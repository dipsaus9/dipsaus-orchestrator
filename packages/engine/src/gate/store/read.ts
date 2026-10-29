// The gate's inputs read through the StoryStore in one worktree (the office's `_base`): the story
// (a draft for a `DRAFT-n` id), every active task with its dependencies and branch (from the
// mirror when the caller has it for this commit, DIPO-180, else the whole task list and one read
// each) and the milestones. The office configuration comes from the caller.

import { openDependencies } from "../../run/select";
import { isProvisionalId } from "../../stories/keys";
import { mapLimited, VIEW_CONCURRENCY } from "../../stories/read";
import { StoryParseError } from "../../story-store/errors";
import type { StoryStore } from "../../story-store/store";
import type { PlainListEntry, PlainTask } from "../../story-store/story";
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

function view(stories: StoryStore, cwd: string, id: string): Promise<PlainTask> {
  return stories.view(cwd, id, isProvisionalId(id) ? "draft" : "task");
}

/** The story's own view reported `not found`: it is not on this worktree's checkout. */
export class StoryNotFoundError extends Error {
  constructor(readonly story: string) {
    super(`${story} is not in the Backlog.md project on this checkout.`);
    this.name = "StoryNotFoundError";
  }
}

/**
 * The active tasks, in the order listed, all of them: a list that misses a task fails the read
 * (DIPO-323) instead of failing a story at R13.
 */
export async function listTasks(
  stories: StoryStore,
  cwd: string,
): Promise<readonly PlainListEntry[]> {
  return (await stories.list(cwd, "task")).entries;
}

/**
 * Every listed id through its own view, once each: the slow read, one CLI call per task. The
 * result is keyed by id in the order listed. A view that does not parse is `undefined`, so the task
 * still counts as active (`gateTasksOf`). `known` is a view the caller already has, not read again.
 */
export async function viewListedTasks(
  stories: StoryStore,
  cwd: string,
  ids: readonly string[],
  known?: PlainTask,
): Promise<Map<string, PlainTask | undefined>> {
  const views = await mapLimited(ids, VIEW_CONCURRENCY, async (id) => {
    if (known !== undefined && id === known.id) return known;
    try {
      return await view(stories, cwd, id);
    } catch (error) {
      if (!(error instanceof StoryParseError)) throw error;
      return undefined;
    }
  });
  return new Map(ids.map((id, i) => [id, views[i]]));
}

/** The views of `viewListedTasks` as GateTask values; a task whose view did not parse has no dependencies or branch. */
export function gateTasksOf(views: ReadonlyMap<string, PlainTask | undefined>): GateTask[] {
  return [...views].map(([id, task]) =>
    task === undefined ? { id, dependencies: [] } : gateTaskFromView(task),
  );
}

/**
 * The gate input of `story`, built from its view, the active tasks as GateTask values (the
 * story's own entry is replaced by its view), the milestone ids and names, the configuration and,
 * when the caller listed them, the base tree's file paths (R29, DIPO-251). Pure: the caller runs
 * the CLI and git. Its subtasks are the view's.
 */
export function gateInputOf(
  story: PlainTask,
  others: readonly GateTask[],
  milestones: readonly string[],
  config: GateConfig,
  baseFiles?: readonly string[],
): GateInput {
  return {
    story: {
      ...gateStoryFromView(
        story,
        story.subtasks.map((task) => task.id),
      ),
      waitingOn: waitingOnOf(story),
    },
    activeTasks: others.map((task) => (task.id === story.id ? gateTaskFromView(story) : task)),
    milestones: [...milestones],
    config,
    ...(baseFiles === undefined ? {} : { baseFiles }),
  };
}

/**
 * Reads the gate input of `story` in the worktree `cwd`. With `others`, the active tasks the
 * mirror holds for this very commit (`cachedGateTasks`), only the story and the milestones go
 * through the store: two reads however many tasks there are. Without it, every listed task is viewed.
 * `baseFiles` are the base tree's file paths the caller listed, passed on in the input.
 * Throws `StoryNotFoundError` when the story is not there, and a `StoryStoreError` when the store
 * fails otherwise or a story does not parse. A failed
 * view fails the read; the input is never built from part of the backlog.
 */
export async function readGateInput(
  stories: StoryStore,
  cwd: string,
  story: string,
  config: GateConfig,
  others?: readonly GateTask[],
  baseFiles?: readonly string[],
): Promise<GateInput> {
  let target;
  try {
    target = await view(stories, cwd, story);
  } catch (error) {
    if (stories.isNotFound(error, story)) {
      throw new StoryNotFoundError(story);
    }
    throw error;
  }
  const activeTasks =
    others ??
    gateTasksOf(
      await viewListedTasks(
        stories,
        cwd,
        (await listTasks(stories, cwd)).map((entry) => entry.id),
        target,
      ),
    );
  const milestones = await stories.milestones(cwd);
  return gateInputOf(target, activeTasks, milestones, config, baseFiles);
}
