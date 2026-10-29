// The story index's read of one story (0007 section 6 step 3): what the engine derives from a
// StoryStore read for the mirror and the Ready gate, its status, created date, labels, tier, role,
// field block and criteria. A story that does not parse (R02) keeps what its list printed, so it
// keeps its key; its created date and branch are then unknown.

import { type FieldBlockPark, StoryId } from "@dipsaus-orchestrator/contract";

import { gateStoryFromView, gateTaskFromView } from "../gate/input";
import { gateContentHash } from "../gate/store/hash";
import type { GateTask } from "../gate/types";
import { openDependencies } from "../run/select";
import { parseFieldBlock } from "../story-store/fields/block";
import { readLabels } from "../story-store/fields/labels";
import type { StoryRead } from "../story-store/store";
import type { StoryKind } from "../story-store/story";

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
  /** The store's hash of what it read, the same wherever the checkout lies. */
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

/** How many story reads run at once. */
export const VIEW_CONCURRENCY = 4;

function single(values: readonly string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** Each read's story, once: a read the store kept from an earlier pass is not derived again. */
const DERIVED = new WeakMap<StoryRead, BacklogStory>();

/** The index's story of one store read; what the list printed fills in when it does not parse. */
export function storyFromRead(read: StoryRead): BacklogStory {
  let story = DERIVED.get(read);
  if (story === undefined) {
    story = derive(read);
    DERIVED.set(read, story);
  }
  return story;
}

function derive(read: StoryRead): BacklogStory {
  const { kind, listed, view } = read;
  const hash = read.contentHash;
  if (view === undefined) {
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
