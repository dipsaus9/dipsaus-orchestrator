// The planning lane of one office as the StoryStore seam offers it (0010, `PlanningLane`): each
// change the engine asks for becomes a journaled operation of its kind with its target state, and
// the reads answer from the journal. `story.park` and `story.drop` (DIPO-160), `work.resume` of a
// hold, `work.discard` (DIPO-161), the pickup check's move to Refined (DIPO-48) and an accepted
// proposal (DIPO-166) reach the lane only through it.

import type { LaneFlush, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../db/office";

import {
  DISCARD_KIND,
  DROP_KIND,
  EDIT_KIND,
  HOLD_KIND,
  OPEN_STATES,
  PROPOSE_KIND,
  RESUME_KIND,
  type PlannedChange,
  type PlanningLane,
} from "../../story-store/planning";

import {
  allEntries,
  failedHold,
  findEntry,
  type JournalEntry,
  type LaneOp,
  updateEntry,
} from "./journal";
import { type FlushReport, LaneFlushError, type OfficeLane } from "./lane";
import { proposeTarget } from "./propose";

/** The Backlog.md statuses a hold applies from; `To Do` is what office init migrates to Refined. */
export const PARKABLE_STATUSES = ["Refined", "Ready", "To Do"];

/** The statuses a discard applies from; never from Done. */
export const DISCARDABLE_STATUSES = [
  "In Progress",
  "In Review",
  "Parked",
  "Ready",
  "Refined",
  "To Do",
];

/** The status a failed pickup check moves a story from, and to. */
const READY_STATUS = "Ready";
const REFINED_STATUS = "Refined";

/** The operation of a discard: status Refined, the park record removed, never over Done. */
export function discardOp(key: StoryKey, story: string): LaneOp & { readonly key: StoryKey } {
  return {
    kind: DISCARD_KIND,
    key,
    subject: story,
    target: { from: DISCARDABLE_STATUSES, status: "Refined", unset: ["park"] },
    releasesClaim: true,
  };
}

/** The branches with a backlog PR recorded on an open operation. */
function branchesWithPr(office: OfficeHandle): Set<string> {
  const branches = new Set<string>();
  for (const entry of allEntries(office)) {
    if (OPEN_STATES.includes(entry.state) && entry.branch !== null && entry.prRef !== null) {
      branches.add(entry.branch);
    }
  }
  return branches;
}

/** The backlog PR recorded on an open operation of `branch`, or null. */
function prOf(office: OfficeHandle, branch: string): string | null {
  return (
    allEntries(office).find(
      (entry) =>
        entry.branch === branch && OPEN_STATES.includes(entry.state) && entry.prRef !== null,
    )?.prRef ?? null
  );
}

/** What a flush left of `entry` when it is not on a branch: merged, closed or still unapplied. */
function offBranch(lane: OfficeLane, report: FlushReport, entry: JournalEntry): LaneFlush | null {
  switch (entry.state) {
    case "merged":
      return { state: "merged" };
    case "dropped":
    case "failed":
    case "withdrawn":
      return { state: "closed", reason: entry.notice ?? `it was ${entry.state}` };
    case "pending":
    case "applied":
      return {
        state: "waiting",
        ...(report.branch === null ? {} : { branch: report.branch }),
        reason: lane.stall()?.reason ?? "the flush did not apply it",
      };
    default:
      return null;
  }
}

/**
 * Read from the journal: what the flush `report` did with `change`, given the branches that had a
 * backlog PR before it (DIPO-401); null when the journal no longer has it.
 */
function flushOf(
  lane: OfficeLane,
  report: FlushReport,
  before: ReadonlySet<string>,
  change: PlannedChange,
): LaneFlush | null {
  const office = lane.office;
  if (report.held === true) {
    const branch = report.branch ?? "";
    return { state: "held", branch, reason: lane.heldReason(branch) };
  }
  const entry = findEntry(office, change.opId);
  if (entry === null) return null;
  const left = offBranch(lane, report, entry);
  if (left !== null) return left;
  const branch = entry.branch ?? report.branch;
  if (branch === null) return null;
  const waiting = report.waiting;
  if (waiting !== null && waiting.branch === branch && entry.state !== "pushed") {
    return { state: "waiting", branch, reason: waiting.detail };
  }
  const pr = prOf(office, branch);
  if (pr === null) return { state: "pushed", branch };
  return { state: before.has(branch) ? "updated" : "opened", branch, pr };
}

/** The office's `PlanningLane` on its `OfficeLane`. */
export function planningLane(lane: OfficeLane): PlanningLane {
  const open = (key: StoryKey, kind: string): JournalEntry | undefined =>
    allEntries(lane.office).find(
      (entry) => entry.key === key && entry.kind === kind && OPEN_STATES.includes(entry.state),
    );
  /** The open entry of the same kind for the story, else a new one (a re-run reuses it). */
  const once = async (op: LaneOp & { readonly key: StoryKey }): Promise<PlannedChange> =>
    open(op.key, op.kind) ?? lane.journal(op);
  return {
    hold: ({ key, story }, park) =>
      once({
        kind: HOLD_KIND,
        key,
        subject: story,
        target: {
          from: PARKABLE_STATUSES,
          status: "Parked",
          fields: { park: { reason: "by-maintainer", from: park.from, note: park.note } },
        },
      }),
    resume: ({ key, story }, to) =>
      once({
        kind: RESUME_KIND,
        key,
        subject: story,
        target: { from: ["Parked"], status: to, unset: ["park"] },
      }),
    drop: ({ key, story }, kind) =>
      once({ kind: DROP_KIND, key, subject: story, target: { kind }, releasesClaim: true }),
    discard: ({ key, story }) => once(discardOp(key, story)),
    toRefined: ({ key, story }) =>
      lane.journal({
        kind: EDIT_KIND,
        key,
        subject: story,
        target: { from: [READY_STATUS], status: REFINED_STATUS },
      }),
    fileDraft: (subject, draft) =>
      lane.journal({
        kind: PROPOSE_KIND,
        subject,
        target: proposeTarget(draft),
      }),
    failedHold(key) {
      const failed = failedHold(lane.office, key);
      if (failed === null) return undefined;
      const from = failed.from === "Ready" || failed.from === "Refined" ? failed.from : null;
      return { opId: failed.opId, from };
    },
    withdraw(change) {
      const office = lane.office;
      office.immediate(() =>
        updateEntry(office, change.opId, { state: "withdrawn" }, lane.clock.now()),
      );
    },
    async flush(change) {
      const before = branchesWithPr(lane.office);
      let report: FlushReport;
      try {
        report = await lane.flush();
      } catch (error) {
        // A failed flush put its own notice on the office and leaves the operations journaled.
        if (!(error instanceof LaneFlushError)) throw error;
        return { state: "failed", reason: error.message };
      }
      return change === undefined ? null : flushOf(lane, report, before, change);
    },
    isOpen: (key, kind) => open(key, kind) !== undefined,
    dropping: () =>
      new Set(
        allEntries(lane.office)
          .filter((entry) => entry.kind === DROP_KIND && OPEN_STATES.includes(entry.state))
          .flatMap((entry) => (entry.key === null ? [] : [entry.key])),
      ),
    draftOf(proposal) {
      const entry = allEntries(lane.office).find(
        (candidate) =>
          candidate.kind === PROPOSE_KIND &&
          (OPEN_STATES.includes(candidate.state) || candidate.state === "merged") &&
          (candidate.target as { proposal?: unknown } | null)?.proposal === proposal,
      );
      return entry === undefined
        ? undefined
        : { opId: entry.opId, open: OPEN_STATES.includes(entry.state) };
    },
  };
}
