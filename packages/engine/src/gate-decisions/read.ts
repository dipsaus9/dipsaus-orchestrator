// The gate's inputs read through the StoryStore in one worktree (the office's `_base`): the story
// (a draft for a `DRAFT-n` id), every active task with its dependencies and branch (from the
// mirror when the caller has it for this commit, DIPO-180, else one pass over the task files,
// DIPO-494) and the milestones. The office configuration comes from the caller.

import { openDependencies } from "../records/select";
import { isProvisionalId } from "../records/story-keys";
import { checkoutFiles } from "../story-store/folder";
import type { StoryStore } from "../story-store/store";
import type { PlainListEntry, PlainTask } from "../story-store/story";
import { gateStoryFromView, gateTaskFromView } from "../gate/input";
import type { GateConfig, GateDependency, GateInput, GateTask } from "../gate/types";

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
 * The other active tasks as the gate reads them (R13, R14, R19), from one pass over the checkout's
 * task files (DIPO-494, `StoryStore.taskFacts`), never one view per task.
 */
export async function otherTasks(stories: StoryStore, cwd: string): Promise<GateTask[]> {
  return (await stories.taskFacts(cwd)).map(({ id, dependencies, branch }) => ({
    id,
    dependencies,
    ...(branch === undefined ? {} : { branch }),
  }));
}

/**
 * The gate input of `story`, built from its view, the active tasks as GateTask values (the
 * story's own entry is replaced by its view), the milestone ids and names, the store's story
 * folders (R12), the configuration and, when the caller listed them, the base tree's file paths
 * (R29, DIPO-251). Pure: the caller runs the CLI and git. Its subtasks are the view's.
 */
export function gateInputOf(
  story: PlainTask,
  others: readonly GateTask[],
  milestones: readonly string[],
  storyFolders: readonly string[],
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
    storyFolders: [...storyFolders],
    config,
    ...(baseFiles === undefined ? {} : { baseFiles }),
  };
}

/** Where `readGateInput` reports how long each of its parts took, at DEBUG (DIPO-494). */
export interface GateReadTiming {
  now(): number;
  debug(message: string, fields: Readonly<Record<string, unknown>>): void;
}

/**
 * Reads the gate input of `story` in the worktree `cwd`. With `others`, the active tasks the
 * mirror holds for this very commit (`cachedGateTasks`), they are not read again. Without it, one
 * pass over the task files reads them (`otherTasks`). Either way the store runs the story's own
 * view and the milestones, and the story folders are read from files: at most three CLI calls,
 * however many tasks there are. `baseFiles` are the base tree's file paths the caller listed,
 * passed on in the input. `timing` gets one DEBUG line with the duration of each part.
 * Throws `StoryNotFoundError` when the story is not there, and a `StoryStoreError` when the store
 * fails otherwise, a story does not parse, or a task file does not. The input is never built from
 * part of the backlog.
 */
export async function readGateInput(
  stories: StoryStore,
  cwd: string,
  story: string,
  config: GateConfig,
  others?: readonly GateTask[],
  baseFiles?: readonly string[],
  timing?: GateReadTiming,
): Promise<GateInput> {
  const parts: Record<string, number | string> = {
    story,
    tasks: others === undefined ? "files" : "mirror",
  };
  let mark = timing?.now() ?? 0;
  const lap = (part: string): void => {
    if (timing === undefined) return;
    const at = timing.now();
    parts[`${part}Ms`] = at - mark;
    mark = at;
  };
  let target;
  try {
    target = await view(stories, cwd, story);
  } catch (error) {
    if (stories.isNotFound(error, story)) {
      throw new StoryNotFoundError(story);
    }
    throw error;
  }
  lap("story");
  const activeTasks = others ?? (await otherTasks(stories, cwd));
  lap("tasks");
  const milestones = await stories.milestones(cwd);
  lap("milestones");
  // The folders R12 keeps out of the References, as the store names them in this checkout.
  const folders = await stories.storyFolders(checkoutFiles(cwd));
  lap("folders");
  timing?.debug("gate input read", parts);
  return gateInputOf(target, activeTasks, milestones, folders, config, baseFiles);
}
