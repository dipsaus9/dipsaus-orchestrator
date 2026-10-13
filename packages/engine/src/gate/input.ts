// Gate inputs from parsed `task view --plain` output. Pure: the caller runs the CLI.

import { FieldBlockError, parseFieldBlock } from "../backlog/fields/block";
import type { PlainTask } from "../backlog/plain";
import type { GateStory, GateTask } from "./types";

/** The story as the gate reads it; `subtasks` are the ids `task list -p <ID>` returned. */
export function gateStoryFromView(task: PlainTask, subtasks: readonly string[]): GateStory {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.type === undefined ? {} : { type: task.type }),
    ...(task.milestone === undefined ? {} : { milestone: task.milestone }),
    labels: task.labels,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    references: task.references,
    documentation: task.documentation,
    dependencies: task.dependencies.map((dep) => dep.id),
    subtasks,
    ...(task.implementationPlan === undefined
      ? {}
      : { implementationPlan: task.implementationPlan }),
  };
}

/** An active task as R13, R14 and R19 read it. A field block that fails to parse has no branch. */
export function gateTaskFromView(task: PlainTask): GateTask {
  let branch: string | undefined;
  try {
    branch = parseFieldBlock(task.description).fields.branch;
  } catch (error) {
    if (!(error instanceof FieldBlockError)) throw error;
  }
  return {
    id: task.id,
    dependencies: task.dependencies.map((dep) => dep.id),
    ...(branch === undefined ? {} : { branch }),
  };
}
