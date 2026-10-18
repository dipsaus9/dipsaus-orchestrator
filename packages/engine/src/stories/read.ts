// Reading every active task and draft through the Backlog CLI (0010 sections 1 and 6, 0007
// section 6 step 3). `task list` and `draft list` give the ids; `task view` and `draft view` give
// each story's status, created date, labels and field block. Archived, completed and draft-folder
// files never appear in `task list`, so they are not active tasks; drafts are read as drafts.
//
// A failed list or view stops the read: a story missing from a partial read would look vanished
// and be closed as Removed. A view that does not parse (R02) still yields the story with what the
// list printed, so it keeps its key; its created date and branch are then unknown.

import { createHash } from "node:crypto";

import { type FieldBlockPark, StoryId } from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import { readLabels } from "../backlog/fields/labels";
import { BacklogParseError, parseList, parseView, plainLines } from "../backlog/plain";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import { gateStoryFromView, gateTaskFromView } from "../gate/input";
import { gateContentHash } from "../gate/store/hash";
import type { GateTask } from "../gate/types";
import { openDependencies } from "../run/select";

export type StoryKind = "task" | "draft";

/** One story as the index read it. */
export interface BacklogStory {
  readonly kind: StoryKind;
  readonly story: StoryId;
  readonly title: string;
  /** The status as the CLI printed it, without its icon. */
  readonly status: string;
  /** The created date exactly as the CLI printed it; absent when the view did not parse. */
  readonly created?: string;
  readonly labels: readonly string[];
  /** The tier when exactly one `tier:<T>` label is set. */
  readonly tier?: string;
  /** The role when exactly one `role:<name>` label is set. */
  readonly role?: string;
  /** The frozen branch from the field block (0012 F15), when the block parses and holds one. */
  readonly frozenBranch?: string;
  /** sha256 of the view output without its `File:` line, so moving the worktree changes nothing. */
  readonly contentHash: string;
  /** The dependencies that are not Done (DIPO-52); absent when the view did not parse. */
  readonly waitingOn?: readonly string[];
  /** The field block's park record (0010 section 3), when the block parses and holds one. */
  readonly park?: FieldBlockPark;
  /**
   * Acceptance criteria checked and in all, and their `#n` numbers (DIPO-85); absent when the view
   * did not parse.
   */
  readonly criteria?: {
    readonly met: number;
    readonly total: number;
    readonly numbers?: readonly number[];
  };
  /**
   * The content hash a Ready gate decision applies to (`gateContentHash`), so reconcile can tell a
   * Ready story without a decision for its content (0007 section 6); absent when the view did not
   * parse.
   */
  readonly gateHash?: string;
  /**
   * What the Ready gate reads of this task when it is one of the other active tasks (DIPO-180):
   * its dependencies and frozen branch, as read on `_base`. Set for tasks, never for drafts. A view
   * that did not parse still counts, without dependencies or branch. A claimed story keeps the
   * base read here although the rest of it is read on its branch.
   */
  readonly gateTask?: GateTask;
  /**
   * Where the story was read (0007 section 6 step 3): the story branch while the story is
   * claimed; absent means the pass's own source, `base`.
   */
  readonly source?: string;
}

/** How many CLI views run at once. */
export const VIEW_CONCURRENCY = 4;

/** sha256 of a view's output without the `File:` line that names where it was read. */
export function contentHash(output: string): string {
  const lines = plainLines(output);
  const body = lines[0]?.startsWith("File: ") ? lines.slice(1) : lines;
  return createHash("sha256").update(body.join("\n")).digest("hex");
}

function single(values: readonly string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** Turns one `--plain` view into a story; `listed` fills in when the view does not parse. */
export function storyFromView(
  kind: StoryKind,
  output: string,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): BacklogStory {
  const hash = contentHash(output);
  let view;
  try {
    view = parseView(output);
  } catch (error) {
    if (!(error instanceof BacklogParseError)) throw error;
    return {
      kind,
      story: StoryId.parse(listed.id),
      title: listed.title,
      status: listed.status,
      labels: [],
      contentHash: hash,
      ...(kind === "task" ? { gateTask: { id: listed.id, dependencies: [] } } : {}),
    };
  }
  const labels = readLabels(view.labels);
  let frozenBranch: string | undefined;
  let park: FieldBlockPark | undefined;
  try {
    const { fields } = parseFieldBlock(view.description);
    frozenBranch = fields.branch;
    park = fields.park;
  } catch {
    // An invalid block (R02) leaves the branch and park unknown; the Ready gate reports it.
    frozenBranch = undefined;
  }
  const tier = single(labels.tiers);
  const role = single(labels.roles);
  return {
    kind,
    story: StoryId.parse(view.id),
    title: view.title,
    status: view.status,
    created: view.created,
    labels: view.labels,
    ...(tier === undefined ? {} : { tier }),
    ...(role === undefined ? {} : { role }),
    ...(frozenBranch === undefined ? {} : { frozenBranch }),
    contentHash: hash,
    waitingOn: openDependencies(view),
    ...(park === undefined ? {} : { park }),
    criteria: {
      met: view.acceptanceCriteria.filter((criterion) => criterion.checked).length,
      total: view.acceptanceCriteria.length,
      numbers: view.acceptanceCriteria.map((criterion) => criterion.index),
    },
    gateHash: gateContentHash(
      gateStoryFromView(
        view,
        view.subtasks.map((task) => task.id),
      ),
    ),
    ...(kind === "task" ? { gateTask: gateTaskFromView(view) } : {}),
  };
}

/** `fn` over `items` with at most `limit` running at once; results in item order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Reads every active task and draft in the worktree `cwd`, in list order. Throws
 * `BacklogCommandError` or `BacklogRefusedError` when the CLI fails, and `BacklogParseError` when
 * a list does not parse.
 */
export async function readBacklog(cli: BacklogCli, cwd: string): Promise<BacklogStory[]> {
  const listed: { kind: StoryKind; id: string; title: string; status: string }[] = [];
  for (const kind of ["task", "draft"] as const) {
    const { stdout } = await runBacklog(cli, cwd, [kind, "list", "--plain"]);
    for (const entry of parseList(stdout).entries) {
      listed.push({
        kind,
        id: entry.id,
        title: entry.title,
        status: kind === "draft" ? "Draft" : entry.group,
      });
    }
  }
  return mapLimited(listed, VIEW_CONCURRENCY, (entry) => readStory(cli, cwd, entry.kind, entry));
}

/**
 * Reads one story in the worktree `cwd` (a claimed story's worktree, DIPO-56); `listed` fills in
 * when the view does not parse. Throws as `runBacklog` does.
 */
export async function readStory(
  cli: BacklogCli,
  cwd: string,
  kind: StoryKind,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): Promise<BacklogStory> {
  const { stdout } = await runBacklog(cli, cwd, [kind, "view", listed.id, "--plain"]);
  return storyFromView(kind, stdout, listed);
}
