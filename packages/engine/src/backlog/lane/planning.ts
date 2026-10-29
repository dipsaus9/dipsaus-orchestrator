// The planning lane of one office as the StoryStore seam offers it (0010, `PlanningLane`): each
// change the engine asks for becomes a journaled operation of its kind with its target state, and
// the reads answer from the journal. `story.park` and `story.drop` (DIPO-160), `work.resume` of a
// hold, `work.discard` (DIPO-161), the pickup check's move to Refined (DIPO-48) and an accepted
// proposal (DIPO-166) reach the lane only through it.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

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

import { allEntries, type JournalEntry, type LaneOp, updateEntry } from "./journal";
import { LaneFlushError, type OfficeLane } from "./lane";
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
    withdraw(change) {
      const office = lane.office;
      office.immediate(() =>
        updateEntry(office, change.opId, { state: "withdrawn" }, lane.clock.now()),
      );
    },
    async flush() {
      // A failed flush put its own notice on the office and leaves the operations journaled.
      await lane.flush().catch((error: unknown) => {
        if (!(error instanceof LaneFlushError)) throw error;
      });
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
