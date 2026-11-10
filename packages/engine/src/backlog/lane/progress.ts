// The planning lane's work in progress (DIPO-481, 0010): what `office.snapshot` and the
// `lane.progress` event say about the open journal entries and the office's open backlog PR, so the
// maintainer sees a change dipo accepted or confirmed is in progress somewhere. Built from the
// journal (`openEntries`) and the backlog PR records (`openPrs`); the PR's CI state is what the
// auto-merge round read through the code host port in its own round (`rememberPr`), never a second
// poll. Every write that changes an entry or the PR appends `progressEntries` in its transaction.

import type { LaneCi, LaneOpView, LaneProgress } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../../changelog/log";
import type { OfficeHandle } from "../../db/office";
import type { RequiredCheck } from "../../platform/host";
import {
  DISCARD_KIND,
  DONE_KIND,
  DROP_KIND,
  EDIT_KIND,
  FILE_KIND,
  HOLD_KIND,
  PROPOSE_KIND,
  READY_KIND,
  REFINE_KIND,
  RESUME_KIND,
  REVISE_KIND,
} from "../../story-store/planning";
import { openPrs } from "../pr/records";

import { type JournalEntry, openEntries } from "./journal";

/** The event the view travels in. */
export const LANE_PROGRESS_EVENT = "lane.progress";

/** What the lane's change of each kind does, in words. */
const WHAT: Readonly<Record<string, string>> = {
  [PROPOSE_KIND]: "an accepted idea filed as a draft",
  [FILE_KIND]: "a confirmed story filed",
  [REVISE_KIND]: "a story edited",
  [REFINE_KIND]: "a draft refined into a story",
  [EDIT_KIND]: "a story edited",
  [READY_KIND]: "a story set Ready",
  [DONE_KIND]: "a story set Done",
  [HOLD_KIND]: "a story parked",
  [RESUME_KIND]: "a parked story resumed",
  [DROP_KIND]: "a story dropped",
  [DISCARD_KIND]: "a story discarded",
  init: "the office's backlog set up",
};

/** What the last auto-merge round read of one backlog PR. */
export interface LivePr {
  readonly ci: LaneCi;
  readonly autoMerge: boolean;
  readonly merged: boolean;
}

/** The CI state of a PR from its required checks; `unknown` when the base requires none. */
export function ciOf(checks: readonly RequiredCheck[] | null): LaneCi {
  if (checks === null || checks.length === 0) return "unknown";
  if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) return "failed";
  if (checks.some((check) => check.bucket === "pending")) return "running";
  return "passed";
}

const live = new WeakMap<OfficeHandle, Map<number, LivePr>>();

/**
 * Keeps what a round read of backlog PR `number`; true when it differs from what was kept. The
 * state is a cache of GitHub's: a daemon start leaves it empty until the first round.
 */
export function rememberPr(office: OfficeHandle, number: number, state: LivePr): boolean {
  let prs = live.get(office);
  if (prs === undefined) {
    prs = new Map();
    live.set(office, prs);
  }
  const before = prs.get(number);
  prs.set(number, state);
  return (
    before === undefined ||
    before.ci !== state.ci ||
    before.autoMerge !== state.autoMerge ||
    before.merged !== state.merged
  );
}

function stateOf(entry: JournalEntry, onBranch: string | null): LaneOpView["state"] {
  if (entry.state === "pushed" && entry.branch === onBranch) return "pr";
  return entry.state === "committed" || entry.state === "pushed" ? "branch" : "queued";
}

/** The open changes and the open backlog PR as the journal and the records say now. */
export function laneProgress(office: OfficeHandle): LaneProgress {
  const entries = openEntries(office);
  const pr = openPrs(office).at(0);
  const state = pr === undefined ? undefined : live.get(office)?.get(pr.number);
  return {
    ops: entries.map((entry) => ({
      op: entry.opId,
      what: WHAT[entry.kind] ?? `a ${entry.kind} change`,
      subject: entry.subject,
      state: stateOf(entry, pr?.branch ?? null),
      since: new Date(entry.createdAt).toISOString(),
    })),
    ...(pr === undefined
      ? {}
      : {
          pr: {
            number: pr.number,
            url: pr.url,
            ci: state?.ci ?? "unknown",
            autoMerge: state?.autoMerge ?? false,
            merged: state?.merged ?? false,
          },
        }),
  };
}

/** The snapshot's view: absent while no change is open. */
export function snapshotLane(office: OfficeHandle): LaneProgress | null {
  const lane = laneProgress(office);
  return lane.ops.length === 0 ? null : lane;
}

/** What the view says of a lane with no open change, as the event carries it. */
const EMPTY = JSON.stringify({ ops: [] });

function lastSent(office: OfficeHandle): string {
  const row = office.get<{ delta: string }>(
    `select delta from change_log where office_id = $office_id and type = $type
      order by seq desc limit 1`,
    { type: LANE_PROGRESS_EVENT },
  );
  if (row === null) return EMPTY;
  const sent = (JSON.parse(row.delta) as { lane: unknown }).lane;
  return JSON.stringify(sent);
}

/**
 * The `lane.progress` entry to append when the lane's view differs from the one last sent, or
 * none; runs inside the caller's transaction, after the change it follows. A lane with no open
 * change and none sent before sends nothing.
 */
export function progressEntries(office: OfficeHandle): NewEntry[] {
  const lane = laneProgress(office);
  // A PR with no change waiting on it is not progress: the view is then the empty one.
  const view: LaneProgress = lane.ops.length === 0 ? { ops: [] } : lane;
  if (JSON.stringify(view) === lastSent(office)) return [];
  return [{ type: LANE_PROGRESS_EVENT, delta: { lane: view } }];
}
