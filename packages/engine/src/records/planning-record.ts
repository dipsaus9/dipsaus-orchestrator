<<<<<<< 10d2521c06c73c873b91abd674a36f1027f386fa
// The record of a planning session (DIPO-450, 0022): the stories its confirmed proposals filed,
// edited or refined from a draft (DIPO-454), by the session's run and the proposal's number. Code
// writes it: an edit when the maintainer confirms it, a new or refined story when the planning lane
// applied it and the story has its id.
// A filing applied again on a newer base can get another id, so its row is replaced, not added.

import type { OfficeHandle } from "../db/office";

/** What a record entry says about its story. */
export type PlanningRecordKind = "filed" | "edited" | "refined";
=======
// The record of a planning session (0007, DIPO-448): one `planning_records` row per entry, in
// order, written by code. The goal, each confirmed choice (question and answer), each filed or
// edited story and each open question are the maintainer's decisions; `started` and `ended` mark
// the model sessions the planning session ran in. A planning session is named by the run id of
// its first model session. A fresh model session's first message is built from the record
// (`planningRecordText`), so no decision lives only in a model context.
//
// Every function here runs inside the caller's transaction.

import type { OfficeHandle } from "../db/office";

export type PlanningEntryKind = "goal" | "choice" | "story" | "question" | "started" | "ended";
>>>>>>> f6a6de3f204aef137bfc56f479ffed3f79cd7ed3

/** One entry as stored. */
export interface PlanningEntry {
  readonly seq: number;
  readonly kind: PlanningEntryKind;
  /** The model session's run, for `started` and `ended`. */
  readonly run: string | null;
  /**
   * `goal`: the planning kind; `choice`: the question; `story`: the story id; `started`: why it
   * started (`start` or the reason the one before ended).
   */
  readonly subject: string | null;
  /** The number of the proposal a `story` entry came from. */
  readonly proposal: number | null;
  /** `goal`: the goal; `choice`: the answer; `story`: `filed` or `edited`; `question`: the question; `ended`: the reason. */
  readonly text: string;
  readonly at: number;
}

/** What a caller adds; the sequence number is the next one of the session. */
export type NewPlanningEntry = Omit<PlanningEntry, "seq" | "run" | "subject" | "proposal"> & {
  readonly run?: string;
  readonly subject?: string;
  readonly proposal?: number;
};

interface Row {
  seq: number;
  kind: PlanningEntryKind;
  run_id: string | null;
  subject: string | null;
  proposal: number | null;
  text: string;
  at: number;
}

/** Appends `entry` to the record of `session`; returns its sequence number. */
export function addPlanningEntry(
  office: OfficeHandle,
  session: string,
  entry: NewPlanningEntry,
): number {
  const next = office.get<{ seq: number }>(
    `select coalesce(max(seq), 0) + 1 as seq from planning_records
      where office_id = $office_id and session_id = $session`,
    { session },
  );
  const seq = next?.seq ?? 1;
  office.run(
    `insert into planning_records (office_id, session_id, seq, kind, run_id, subject, proposal, text, at)
     values ($office_id, $session, $seq, $kind, $run, $subject, $proposal, $text, $at)`,
    {
      session,
      seq,
      kind: entry.kind,
      run: entry.run ?? null,
      subject: entry.subject ?? null,
      proposal: entry.proposal ?? null,
      text: entry.text,
      at: entry.at,
    },
  );
  return seq;
}

/** The record of `session`, in order. */
export function readPlanningRecord(office: OfficeHandle, session: string): PlanningEntry[] {
  return office
    .all<Row>(
      `select seq, kind, run_id, subject, proposal, text, at from planning_records
        where office_id = $office_id and session_id = $session order by seq`,
      { session },
    )
    .map((row) => ({
      seq: row.seq,
      kind: row.kind,
      run: row.run_id,
      subject: row.subject,
      proposal: row.proposal,
      text: row.text,
      at: row.at,
    }));
}

/** The session a model session `run` belongs to; null for a run no record names. */
export function planningSessionOfRun(office: OfficeHandle, run: string): string | null {
  return (
    office.get<{ session_id: string }>(
      `select session_id from planning_records
        where office_id = $office_id and kind = 'started' and run_id = $run`,
      { run },
    )?.session_id ?? null
  );
}

/** A planning session that can continue in a fresh model session. */
export interface ContinuableSession {
  readonly session: string;
  readonly kind: string;
  readonly goal: string;
  /** The model session that ended last, and why. */
  readonly previous: string;
  readonly reason: string;
}

/**
 * The newest planning session of the office whose model session ended and that the maintainer
 * did not end: it ended by idle, a daemon stop, the model session's exit or a full context, or
 * the start of a fresh one failed after an earlier model session ran. Null otherwise.
 */
export function continuableSession(office: OfficeHandle): ContinuableSession | null {
  const newest = office.get<{ session_id: string }>(
    `select session_id from planning_records
      where office_id = $office_id and kind = 'goal' order by at desc, rowid desc limit 1`,
  );
  if (newest === null) return null;
  const entries = readPlanningRecord(office, newest.session_id);
  const goal = entries.find((entry) => entry.kind === "goal");
  const last = entries.findLast((entry) => entry.kind === "ended");
  if (goal === undefined || last === undefined || last.run === null) return null;
  // A model session started after the last end still runs.
  if (entries.some((entry) => entry.kind === "started" && entry.seq > last.seq)) return null;
  if (last.text === "maintainer") return null;
  const started = entries.filter((entry) => entry.kind === "started").length;
  if (last.text === "start-failed" && started <= 1) return null;
  return {
    session: newest.session_id,
    kind: goal.subject ?? "plan",
    goal: goal.text,
    previous: last.run,
    reason: last.text,
  };
}

/** The open questions: those no later choice answered. */
export function openQuestions(entries: readonly PlanningEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === "question")
    .filter(
      (question) =>
        !entries.some(
          (entry) =>
            entry.kind === "choice" && entry.seq > question.seq && entry.subject === question.text,
        ),
    )
    .map((entry) => entry.text);
}

const section = (title: string, lines: readonly string[], none: string): string =>
  `${title}:\n${lines.length === 0 ? none : lines.join("\n")}`;

/**
 * Pure: the record as text for a fresh model session's first message: the decisions, the filed
 * and edited stories and the open questions, in the order they were recorded.
 */
export function planningRecordText(entries: readonly PlanningEntry[]): string {
  const decisions = entries
    .filter((entry) => entry.kind === "choice")
    .map((entry) => `- ${entry.subject ?? ""}: ${entry.text}`);
  const stories = entries
    .filter((entry) => entry.kind === "story")
    .map((entry) => `- ${entry.subject ?? ""}: ${entry.text}`);
  const questions = openQuestions(entries).map((question) => `- ${question}`);
  return [
    section("Decisions the maintainer confirmed", decisions, "None yet."),
    section("Stories filed or edited", stories, "None yet."),
    section("Open questions", questions, "None."),
  ].join("\n\n");
}

/**
 * Records a story a confirmed proposal filed or edited (DIPO-450) in the record of the session the
 * model session `run` belongs to. A story already recorded with the same kind is not added again.
 * Does nothing for a run no record names.
 */
export function recordStoryEntry(
  office: OfficeHandle,
  run: string,
  entry: {
    readonly proposal: number;
    readonly story: string;
    readonly kind: "filed" | "edited";
    readonly at: number;
  },
): void {
  const session = planningSessionOfRun(office, run);
  if (session === null) return;
  const seen = office.get<{ seq: number }>(
    `select seq from planning_records
      where office_id = $office_id and session_id = $session and kind = 'story'
        and subject = $story and text = $text`,
    { session, story: entry.story, text: entry.kind },
  );
  if (seen !== null) return;
  addPlanningEntry(office, session, {
    kind: "story",
    subject: entry.story,
    proposal: entry.proposal,
    text: entry.kind,
    at: entry.at,
  });
}
