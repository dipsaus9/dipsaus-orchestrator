// The minimal story view (0005 sections 5 and 6, 0009 section 3). The engine derives views from
// facts and never stores them as truth; the change log keeps the view each writer derived at that
// moment. This version knows the key, the id, the title, the lifecycle and the tier, and takes the
// queue column from the lifecycle alone. DIPO-52 adds waiting-on, gate messages, the held column
// for on-hold parks, work and health.

import {
  type Lifecycle,
  type QueueColumn,
  StoryKey,
  StoryId,
  type StoryView,
  type Tier,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { isProvisionalId } from "../stories/keys";

/**
 * The column a story shows in, from its lifecycle alone. A removed story is in no queue column;
 * its view says `removed`, an open-enum value clients show generically, and they drop the story.
 */
export const LIFECYCLE_COLUMNS: Readonly<Record<Lifecycle, QueueColumn>> = {
  Draft: "draft",
  Refined: "refined",
  Ready: "ready",
  "In Progress": "running",
  "In Review": "review",
  Parked: "desk",
  Done: "done",
  Removed: "removed",
};

export function columnOf(lifecycle: Lifecycle): QueueColumn {
  return LIFECYCLE_COLUMNS[lifecycle];
}

/** The facts a story view is derived from. */
export interface StoryFacts {
  readonly key: StoryKey;
  readonly story: StoryId;
  readonly title: string;
  readonly lifecycle: Lifecycle;
  readonly tier?: Tier;
}

export function deriveStoryView(facts: StoryFacts): StoryView {
  return {
    key: facts.key,
    story: facts.story,
    provisional: isProvisionalId(facts.story),
    title: facts.title,
    lifecycle: facts.lifecycle,
    ...(facts.tier === undefined ? {} : { tier: facts.tier }),
    column: columnOf(facts.lifecycle),
  };
}

/** The Backlog.md statuses of 0012 that name a lifecycle as they are. */
const STATUS_LIFECYCLES: ReadonlySet<string> = new Set([
  "Refined",
  "Ready",
  "In Progress",
  "In Review",
  "Parked",
  "Done",
]);

/**
 * The lifecycle of a story Backlog.md holds: a draft is `Draft` whatever its status; a task's 0012
 * status is its lifecycle. `To Do`, the status office init migrates to `Refined` (0010 section 6),
 * and any status outside 0012 count as `Refined`: the story is planned but not Ready.
 */
export function lifecycleOf(kind: "task" | "draft", status: string): Lifecycle {
  if (kind === "draft") return "Draft";
  return STATUS_LIFECYCLES.has(status) ? (status as Lifecycle) : "Refined";
}

/** True when a task status is neither a 0012 status nor `To Do`. */
export function isUnknownStatus(kind: "task" | "draft", status: string): boolean {
  return kind === "task" && status !== "To Do" && !STATUS_LIFECYCLES.has(status);
}

interface StoryViewRow {
  key: string;
  story_id: string;
  removed_at: number | null;
  kind: "task" | "draft" | null;
  status: string | null;
  title: string | null;
  tier: string | null;
}

const VIEW_SELECT = `
  select s.key as key, s.story_id as story_id, s.removed_at as removed_at,
         m.kind as kind, m.status as status, m.title as title, m.tier as tier
    from stories s
    left join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
   where s.office_id = $office_id`;

function viewOfRow(row: StoryViewRow): StoryView {
  const lifecycle: Lifecycle =
    row.removed_at !== null || row.kind === null || row.status === null
      ? "Removed"
      : lifecycleOf(row.kind, row.status);
  return deriveStoryView({
    key: StoryKey.parse(row.key),
    story: StoryId.parse(row.story_id),
    title: row.title ?? "",
    lifecycle,
    ...(row.tier === null ? {} : { tier: row.tier }),
  });
}

/** The current view of one story from the office's rows; null when the key is unknown. */
export function storyView(office: OfficeHandle, key: StoryKey): StoryView | null {
  const row = office.get<StoryViewRow>(`${VIEW_SELECT} and s.key = $key`, { key });
  return row === null ? null : viewOfRow(row);
}

/** The views of every story that is not removed, by Backlog.md id. */
export function activeStoryViews(office: OfficeHandle): StoryView[] {
  return office
    .all<StoryViewRow>(`${VIEW_SELECT} and s.removed_at is null order by s.story_id`)
    .map(viewOfRow);
}
