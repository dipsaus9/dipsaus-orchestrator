// The story view (0005 sections 5 and 6, 0009 section 3). The engine derives views from facts and
// never stores them as truth; the change log keeps the view each writer derived at that moment.
// The facts are the story's key and id, what the story index mirrored from Backlog.md (lifecycle,
// title, tier, open dependencies, the field block's park record), the latest Ready gate decision,
// and the story's active run.
//
// Column (one of the eight 0009 columns): a Ready story whose dependency is not Done is `waiting`
// with `waitingOn`; a Parked story is `desk`, whatever its reason; every other
// lifecycle maps one to one. A removed story is in no queue column: its view says `removed`, an
// open-enum value clients show generically, and they drop the story.

import {
  FieldBlockPark,
  type Lifecycle,
  type ParkRecord,
  type QueueColumn,
  StoryKey,
  StoryId,
  type StoryPr,
  type StoryView,
  type Tier,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { gateText } from "../gate/rules";
import type { RuleResult } from "../gate-decisions";
import { activeRuns } from "../records/run-records";
import { latestStoryPr } from "../records/story-prs";
import { isProvisionalId } from "../records/story-keys";

import { workRefOf } from "./work";

/** The column of each lifecycle when no other fact decides it. */
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

/** The column from the lifecycle alone. */
export function columnOf(lifecycle: Lifecycle): QueueColumn {
  return LIFECYCLE_COLUMNS[lifecycle];
}

/** A park record as the field block holds it, with when the index first saw it. */
export interface ParkFacts extends FieldBlockPark {
  readonly since: number;
}

/**
 * One failure that sent a story back to Refined: a failed Ready gate rule with its `rule`, or a
 * pickup check message no rule gave (a story that could not be sized), without one.
 */
export interface GateFailureFact {
  readonly rule?: string;
  readonly message: string;
}

/** The facts a story view is derived from. */
export interface StoryFacts {
  readonly key: StoryKey;
  readonly story: StoryId;
  readonly title: string;
  readonly lifecycle: Lifecycle;
  readonly tier?: Tier;
  /** Dependencies that are not Done. */
  readonly waitingOn?: readonly string[];
  /** The field block's park record while Parked. */
  readonly park?: ParkFacts;
  /** The failures of the latest Ready gate decision, when it failed. */
  readonly gateFailures?: readonly GateFailureFact[];
  /** Who works on the story's active run. */
  readonly work?: WorkRef;
  /** The story's PR on the code host (0019 section 3). */
  readonly pr?: StoryPr;
}

/** The column a story shows in (0009 section 3). */
export function deriveColumn(facts: Pick<StoryFacts, "lifecycle" | "waitingOn">): QueueColumn {
  if (facts.lifecycle === "Ready" && (facts.waitingOn?.length ?? 0) > 0) return "waiting";
  return columnOf(facts.lifecycle);
}

function parkedOf(park: ParkFacts): ParkRecord {
  return {
    reason: park.reason,
    detail: park.note,
    from: park.from,
    since: new Date(park.since).toISOString(),
  };
}

export function deriveStoryView(facts: StoryFacts): StoryView {
  const column = deriveColumn(facts);
  const failures = facts.lifecycle === "Refined" ? (facts.gateFailures ?? []) : [];
  const gateMessages = failures.map((failure) => failure.message);
  const ruleFailures = failures.flatMap(({ rule, message }) =>
    rule === undefined ? [] : [{ rule, message, text: gateText(rule, message) }],
  );
  return {
    key: facts.key,
    story: facts.story,
    provisional: isProvisionalId(facts.story),
    title: facts.title,
    lifecycle: facts.lifecycle,
    ...(facts.tier === undefined ? {} : { tier: facts.tier }),
    column,
    ...(facts.work === undefined ? {} : { work: facts.work }),
    ...(facts.pr === undefined ? {} : { pr: facts.pr }),
    ...(facts.lifecycle === "Parked" && facts.park !== undefined
      ? { parked: parkedOf(facts.park) }
      : {}),
    ...(column === "waiting"
      ? { waitingOn: (facts.waitingOn ?? []).map((id) => StoryId.parse(id)) }
      : {}),
    ...(gateMessages.length === 0 ? {} : { gateMessages }),
    ...(ruleFailures.length === 0 ? {} : { gateFailures: ruleFailures }),
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
  waiting_on: string | null;
  park: string | null;
  park_since: number | null;
}

const VIEW_SELECT = `
  select s.key as key, s.story_id as story_id, s.removed_at as removed_at,
         m.kind as kind, m.status as status, m.title as title, m.tier as tier,
         m.waiting_on as waiting_on, m.park as park, m.park_since as park_since
    from stories s
    left join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
   where s.office_id = $office_id`;

/** A stored JSON array of ids; none when absent. */
function idsOf(json: string | null): string[] {
  if (json === null) return [];
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function parkOf(json: string | null, since: number | null): ParkFacts | undefined {
  if (json === null || since === null) return undefined;
  const parsed = FieldBlockPark.safeParse(JSON.parse(json));
  return parsed.success ? { ...parsed.data, since } : undefined;
}

/** The failed rules of the story's latest Ready gate decision, when it failed. */
export function gateFailures(office: OfficeHandle, key: string): GateFailureFact[] {
  const row = office.get<{ decision: string; rule_results: string }>(
    `select d.decision, d.rule_results from gate_decisions d
       join gates g on g.office_id = d.office_id and g.gate_id = d.gate_id
      where d.office_id = $office_id and g.key = $key and g.kind in ('ready', 'pickup')
      order by d.decided_at desc, d.rowid desc limit 1`,
    { key },
  );
  if (row === null || row.decision !== "rejected") return [];
  const results = JSON.parse(row.rule_results) as RuleResult[];
  return results
    .filter((result) => !result.passed)
    .flatMap(({ rule, messages }) => messages.map((message) => ({ rule, message })));
}

/** Who works on each story with an active run, by key; pass it to `storyView` for many stories. */
export function workByKey(office: OfficeHandle): Map<string, WorkRef> {
  const byKey = new Map<string, WorkRef>();
  for (const run of activeRuns(office)) {
    if (run.key === null) continue;
    const ref = workRefOf(office, run.runId);
    if (ref !== null) byKey.set(run.key, ref);
  }
  return byKey;
}

function viewOfRow(
  office: OfficeHandle,
  row: StoryViewRow,
  work: ReadonlyMap<string, WorkRef>,
): StoryView {
  const lifecycle: Lifecycle =
    row.removed_at !== null || row.kind === null || row.status === null
      ? "Removed"
      : lifecycleOf(row.kind, row.status);
  const park = parkOf(row.park, row.park_since);
  const ref = work.get(row.key);
  const pr = latestStoryPr(office, row.key);
  return deriveStoryView({
    key: StoryKey.parse(row.key),
    story: StoryId.parse(row.story_id),
    title: row.title ?? "",
    lifecycle,
    ...(row.tier === null ? {} : { tier: row.tier }),
    waitingOn: idsOf(row.waiting_on),
    ...(park === undefined ? {} : { park }),
    gateFailures: lifecycle === "Refined" ? gateFailures(office, row.key) : [],
    ...(ref === undefined ? {} : { work: ref }),
    ...(pr === null ? {} : { pr: { number: pr.number, url: pr.url, state: pr.state } }),
  });
}

/**
 * The current view of one story from the office's rows; null when the key is unknown. `work` is
 * `workByKey(office)`, derived once by a caller that views many stories.
 */
export function storyView(
  office: OfficeHandle,
  key: StoryKey,
  work: ReadonlyMap<string, WorkRef> = workByKey(office),
): StoryView | null {
  const row = office.get<StoryViewRow>(`${VIEW_SELECT} and s.key = $key`, { key });
  return row === null ? null : viewOfRow(office, row, work);
}

/** The views of every story that is not removed, by Backlog.md id. */
export function activeStoryViews(office: OfficeHandle): StoryView[] {
  const work = workByKey(office);
  return office
    .all<StoryViewRow>(`${VIEW_SELECT} and s.removed_at is null order by s.story_id`)
    .map((row) => viewOfRow(office, row, work));
}
