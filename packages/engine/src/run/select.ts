// Picking the story `work.run` starts (0012 sections 2 and 3, 0005 section 4). Pure: the caller
// reads the stories on `origin/<base>` through the Backlog CLI and passes them in.
//
// Without `stories` the candidates are the Ready stories, by priority (high, medium, low, none),
// then ordinal (lowest first, none last), then id. A story is eligible when it is Ready and every
// dependency is Done (0012 section 2).

import type { SkipReason } from "@dipsaus-orchestrator/contract";

import type { PlainTask } from "../story-store/story";

/** The status a run picks (0012 section 2). */
export const READY_STATUS = "Ready";

const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

/** high 0, medium 1, low 2, anything else (none) 3. */
export function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[(priority ?? "").toLowerCase()] ?? 3;
}

const idParts = (id: string): string[] => id.split(/[-.]/);

/** `TASK-2` before `TASK-10`: the prefix, then each numeric part. */
function compareIds(a: string, b: string): number {
  const left = idParts(a);
  const right = idParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "";
    const y = right[i] ?? "";
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (x !== "" && y !== "" && Number.isInteger(nx) && Number.isInteger(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The pickup order of `tasks`: priority, then ordinal, then id. */
export function pickupOrder<T extends Pick<PlainTask, "id" | "priority" | "ordinal">>(
  tasks: readonly T[],
): T[] {
  return tasks.toSorted((a, b) => {
    const priority = priorityRank(a.priority) - priorityRank(b.priority);
    if (priority !== 0) return priority;
    const left = a.ordinal ?? Number.POSITIVE_INFINITY;
    const right = b.ordinal ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return compareIds(a.id, b.id);
  });
}

/** Dependency statuses that count as Done: `Done`, and `completed` for a task in `completed/`. */
function isDone(status: string | undefined): boolean {
  const value = (status ?? "").toLowerCase();
  return value === "done" || value === "completed";
}

/** The dependencies of `task` that are not Done (a missing or ambiguous one is not Done). */
export function openDependencies(task: Pick<PlainTask, "dependencies">): string[] {
  return task.dependencies
    .filter((dependency) => dependency.state !== "resolved" || !isDone(dependency.status))
    .map((dependency) => dependency.id);
}

/**
 * Why a story with `status` is not started for its status alone, or null for Ready: `parked` for
 * Parked, `notReady` for Refined and statuses outside 0012 (planned but not Ready), `notRunnable`
 * for the states run never picks (In Progress, In Review, Done).
 */
export function statusSkip(status: string): SkipReason | null {
  if (status === READY_STATUS) return null;
  if (status === "Parked") return "parked";
  if (status === "In Progress" || status === "In Review" || status === "Done") return "notRunnable";
  return "notReady";
}
