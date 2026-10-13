// Reading every active task and draft through the Backlog CLI (0010 sections 1 and 6, 0007
// section 6 step 3). `task list` and `draft list` give the ids; `task view` and `draft view` give
// each story's status, created date, labels and field block. Archived, completed and draft-folder
// files never appear in `task list`, so they are not active tasks; drafts are read as drafts.
//
// A failed list or view stops the read: a story missing from a partial read would look vanished
// and be closed as Removed. A view that does not parse (R02) still yields the story with what the
// list printed, so it keeps its key; its created date and branch are then unknown.

import { createHash } from "node:crypto";

import { StoryId } from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import { readLabels } from "../backlog/fields/labels";
import { BacklogParseError, parseList, parseView, plainLines } from "../backlog/plain";
import { type BacklogCli, runBacklog } from "../backlog/runner";

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
    };
  }
  const labels = readLabels(view.labels);
  let frozenBranch: string | undefined;
  try {
    frozenBranch = parseFieldBlock(view.description).fields.branch;
  } catch {
    // An invalid block (R02) leaves the branch unknown; the Ready gate reports it.
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
  return mapLimited(listed, VIEW_CONCURRENCY, async (entry) => {
    const { stdout } = await runBacklog(cli, cwd, [entry.kind, "view", entry.id, "--plain"]);
    return storyFromView(entry.kind, stdout, entry);
  });
}
