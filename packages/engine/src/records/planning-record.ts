// The record of a planning session (0007, DIPO-448): one `planning_records` row per entry, in
// order, written by code. The goal, each confirmed choice (question and answer), each filed or
// edited story and each open question are the maintainer's decisions; `started` and `ended` mark
// the model sessions the planning session ran in. Each maintainer message and the last answer of
// each model session are kept too (DIPO-489), so a fresh session can say where the talk stopped. A planning session is named by the run id of
// its first model session. A fresh model session's first message is built from the record
// (`planningRecordText`), so no decision lives only in a model context.
//
// A planning session is a thread of the office chat (DIPO-523, 0024), and its record is the
// thread's record: its goal is the thread's title, and an `ended` entry of `maintainer` (`/end`)
// or `idle` closes it for good (`openThreads`, `closeThread`).
//
// Every function here runs inside the caller's transaction.

import type { OfficeHandle } from "../db/office";

export type PlanningEntryKind =
  | "goal"
  | "choice"
  | "story"
  | "question"
  | "started"
  | "ended"
  | "message"
  | "answer";

/** One entry as stored. */
export interface PlanningEntry {
  readonly seq: number;
  readonly kind: PlanningEntryKind;
  /** The model session's run, for `started`, `ended` and `story` (DIPO-480). */
  readonly run: string | null;
  /**
   * `goal`: the planning kind; `choice`: the question; `story`: the story id; `started`: why it
   * started (`start` or the reason the one before ended).
   */
  readonly subject: string | null;
  /** The number of the proposal a `story` entry came from. */
  readonly proposal: number | null;
  /** `message` and `answer`: the end of the model session's stored output when it was made. */
  readonly outputOffset: number | null;
  /** `message`: the maintainer's text; `answer`: the model's last answer of its session; `goal`: the goal; `choice`: the answer; `story`: `filed` or `edited`; `question`: the question; `ended`: the reason. */
  readonly text: string;
  readonly at: number;
}

/** What a caller adds; the sequence number is the next one of the session. */
export type NewPlanningEntry = Omit<
  PlanningEntry,
  "seq" | "run" | "subject" | "proposal" | "outputOffset"
> & {
  readonly run?: string;
  readonly subject?: string;
  readonly proposal?: number;
  readonly outputOffset?: number;
};

interface Row {
  seq: number;
  kind: PlanningEntryKind;
  run_id: string | null;
  subject: string | null;
  proposal: number | null;
  output_offset: number | null;
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
    `insert into planning_records (office_id, session_id, seq, kind, run_id, subject, proposal, output_offset, text, at)
     values ($office_id, $session, $seq, $kind, $run, $subject, $proposal, $offset, $text, $at)`,
    {
      session,
      seq,
      kind: entry.kind,
      run: entry.run ?? null,
      subject: entry.subject ?? null,
      proposal: entry.proposal ?? null,
      offset: entry.outputOffset ?? null,
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
      `select seq, kind, run_id, subject, proposal, output_offset, text, at from planning_records
        where office_id = $office_id and session_id = $session order by seq`,
      { session },
    )
    .map((row) => ({
      seq: row.seq,
      kind: row.kind,
      run: row.run_id,
      subject: row.subject,
      proposal: row.proposal,
      outputOffset: row.output_offset,
      text: row.text,
      at: row.at,
    }));
}

/**
 * Keeps `answer` as the last answer of the model session `run`: an older answer entry of that
 * run is dropped, so the record holds one answer per model session.
 */
export function recordLastAnswer(
  office: OfficeHandle,
  session: string,
  entry: {
    readonly run: string;
    readonly text: string;
    readonly outputOffset: number;
    readonly at: number;
  },
): void {
  office.run(
    `delete from planning_records
      where office_id = $office_id and session_id = $session and kind = 'answer' and run_id = $run`,
    { session, run: entry.run },
  );
  addPlanningEntry(office, session, { kind: "answer", ...entry });
}

/** The end of the stored worker output of `run`; 0 before any. */
export function outputEndOf(office: OfficeHandle, run: string): number {
  return (
    office.get<{ end: number | null }>(
      `select max(to_offset) as end from output_chunks
        where office_id = $office_id and run_id = $run and source = 'worker'`,
      { run },
    )?.end ?? 0
  );
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

/** The record's `ended` reasons that close a thread for good (DIPO-523): `/end` and a day idle. */
export const CLOSING_REASONS: readonly string[] = ["maintainer", "idle"];

/** An open thread of the office chat (DIPO-523): a planning session that was not closed. */
export interface OpenThread {
  readonly session: string;
  readonly kind: string;
  readonly goal: string;
  /** The model session that ended last, and why; null while a model session of it runs. */
  readonly previous: string | null;
  readonly reason: string | null;
  /** The time of its newest entry, from which it counts as idle. */
  readonly lastAt: number;
}

/**
 * The open threads of the office, the newest first: each planning session with a goal that no
 * `ended` entry of a closing reason closed, leaving out one whose only model session failed to
 * start. A planning session open before the chat (DIPO-523) is an open thread titled by its goal.
 */
export function openThreads(office: OfficeHandle): OpenThread[] {
  const rows = office.all<{ session_id: string; last_at: number }>(
    `select p.session_id, max(p.at) as last_at from planning_records p
      where p.office_id = $office_id
        and exists (select 1 from planning_records g
                     where g.office_id = p.office_id and g.session_id = p.session_id
                       and g.kind = 'goal')
        and not exists (select 1 from planning_records c
                         where c.office_id = p.office_id and c.session_id = p.session_id
                           and c.kind = 'ended' and c.text in ('maintainer', 'idle'))
      group by p.session_id
      order by last_at desc, max(p.rowid) desc`,
  );
  return rows.flatMap((row): OpenThread[] => {
    const entries = readPlanningRecord(office, row.session_id);
    const goal = entries.find((entry) => entry.kind === "goal");
    if (goal === undefined) return [];
    const last = entries.findLast((entry) => entry.kind === "ended");
    const running =
      last === undefined ||
      entries.some((entry) => entry.kind === "started" && entry.seq > last.seq);
    const started = entries.filter((entry) => entry.kind === "started").length;
    if (!running && last?.text === "start-failed" && started <= 1) return [];
    return [
      {
        session: row.session_id,
        kind: goal.subject ?? "plan",
        goal: goal.text,
        previous: running ? null : (last?.run ?? null),
        reason: running ? null : (last?.text ?? null),
        lastAt: row.last_at,
      },
    ];
  });
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
 * The newest open thread of the office whose model session ended: by a daemon stop, its exit, a
 * full context or a switch to another thread, or the start of a fresh one failed after an earlier
 * model session ran. Null when the newest open thread runs, or none is open.
 */
export function continuableSession(office: OfficeHandle): ContinuableSession | null {
  const newest = openThreads(office)[0];
  if (newest === undefined || newest.previous === null || newest.reason === null) return null;
  return {
    session: newest.session,
    kind: newest.kind,
    goal: newest.goal,
    previous: newest.previous,
    reason: newest.reason,
  };
}

/** Closes the thread `session` whose model session `run` ended last, for `reason` (DIPO-523). */
export function closeThread(
  office: OfficeHandle,
  session: string,
  entry: { readonly run: string; readonly reason: string; readonly at: number },
): void {
  addPlanningEntry(office, session, {
    kind: "ended",
    run: entry.run,
    text: entry.reason,
    at: entry.at,
  });
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

/** A story a planning session filed or edited, as its next message lists it (DIPO-480). */
export interface FiledStory {
  readonly story: string;
  readonly kind: "filed" | "edited";
  /** The story as filed: the title and, for an edit, the fields it changed; null when the lane no longer has it. */
  readonly title: string | null;
  readonly dependencies: readonly string[];
  /** The full text as filed, or the changed fields of an edit; null when the lane no longer has it. */
  readonly text: string | null;
  /** `open`: filed, its backlog PR open; `merged`: on the base since `since`; `closed`: given up; `unknown`: the lane has no journal of it and it is not on the base. */
  readonly state: "open" | "merged" | "closed" | "unknown";
  readonly since: string | null;
  readonly notice: string | null;
}

/** Pure: how a story's state reads in the list. */
function filedState(filed: FiledStory): string {
  const what = filed.kind === "filed" ? "filed" : "edited";
  if (filed.state === "merged")
    return `${what}, on the base since commit ${filed.since ?? "unknown"}`;
  if (filed.state === "closed") {
    return `${what}, but its backlog change was closed and is not on any branch${filed.notice === null ? "" : ` (${filed.notice})`}`;
  }
  return `${what}, backlog PR open`;
}

/** Pure: the stories of the session as a list: each with id, title, dependencies, state and text. */
export function filedStoriesText(stories: readonly FiledStory[]): string {
  return stories
    .map((filed) =>
      filed.state === "unknown"
        ? `- ${filed.story}: ${filed.kind}`
        : [
            `- ${filed.story}${filed.title === null ? "" : `: ${filed.title}`}`,
            `  state: ${filedState(filed)}`,
            ...(filed.kind === "filed"
              ? [
                  `  dependencies: ${filed.dependencies.length === 0 ? "none" : filed.dependencies.join(", ")}`,
                ]
              : []),
            ...(filed.text === null
              ? []
              : [
                  `  text as ${filed.kind}:`,
                  ...filed.text.split("\n").map((line) => `    ${line}`),
                ]),
          ].join("\n"),
    )
    .join("\n");
}

/**
 * Pure: the record as text for a fresh model session's first message: the decisions, the filed
 * and edited stories (with `filed`, each with its state and text) and the open questions, in the
 * order they were recorded. A fresh model session of a session that ran one before also gets a
 * line that it continues it, with the maintainer's last message and the last answer (DIPO-489).
 */
export function planningRecordText(
  entries: readonly PlanningEntry[],
  filed?: readonly FiledStory[],
): string {
  const decisions = entries
    .filter((entry) => entry.kind === "choice")
    .map((entry) => `- ${entry.subject ?? ""}: ${entry.text}`);
  const stories =
    filed === undefined
      ? entries
          .filter((entry) => entry.kind === "story")
          .map((entry) => `- ${entry.subject ?? ""}: ${entry.text}`)
      : filed.length === 0
        ? []
        : [filedStoriesText(filed)];
  const questions = openQuestions(entries).map((question) => `- ${question}`);
  const continued = entries.filter((entry) => entry.kind === "started").length > 1;
  const message = entries.findLast((entry) => entry.kind === "message");
  const answer = entries.findLast((entry) => entry.kind === "answer");
  // The messages the chat sent after the last answer, which no model session read yet (DIPO-523):
  // they follow the answer, and the fresh model session answers them.
  const unread =
    answer === undefined
      ? []
      : entries.filter((entry) => entry.kind === "message" && entry.seq > answer.seq);
  const last = unread.length > 0 ? unread : message === undefined ? [] : [message];
  const messages = last.map(
    (entry) =>
      `The maintainer's ${last.length === 1 ? "last message" : "message"} (${new Date(entry.at).toISOString()}):\n${entry.text}`,
  );
  const answered =
    answer === undefined
      ? []
      : [
          `The previous model session's last answer (${new Date(answer.at).toISOString()}):\n${answer.text}`,
        ];
  return [
    section("Decisions the maintainer confirmed", decisions, "None yet."),
    section("Stories filed or edited", stories, "None yet."),
    section("Open questions", questions, "None."),
    ...(continued
      ? [
          [
            "This continues the planning session: the model session before this one ended, and you do not remember it. Pick up the conversation where it stopped.",
            ...(unread.length > 0 ? [...answered, ...messages] : [...messages, ...answered]),
          ].join("\n\n"),
        ]
      : []),
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
    run,
    subject: entry.story,
    proposal: entry.proposal,
    text: entry.kind,
    at: entry.at,
  });
}
