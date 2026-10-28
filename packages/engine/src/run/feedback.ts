// One feedback path (0002, 0008, 0020): every text dipo sends a developer session goes through
// `sendFeedback`, tagged with its source.
//
// - Stored first. Each message is a `steer` intent `feedback <source> <key> <via> <text>` on the
//   run, written before anything is sent. `key` is what the message is keyed on: the request of a
//   steer (so a retry of the request stores nothing twice), the agent a report correction went to,
//   or `-`. `via` is `now` for a message sent to a live session and `next` for one held for the
//   next session. `text` is the message as the worker reads it.
// - Now or with the next session. A caller whose run has a live developer session passes the
//   sender (`FeedbackSender`): the message goes at once as one next-priority user message (0008),
//   and the intent is marked `sent`, or `failed` with the reason the host gave. Without a sender
//   (a parked story, a run between two sessions, a run waiting for its place) the intent stays
//   `pending`, and the first message of the run's next developer session carries every pending
//   held message (`heldFeedback`): the findings and the other code-built messages first, then the
//   maintainer's own words (a resume note, a steer, a held answer), each group oldest first. They are marked
//   delivered, with the feedback items they carry, in the transaction that records that session's
//   agent (`deliverHeld`), so a stop after the start never sends them twice. A `now` message
//   left `pending` by a stop between its store and its send is never replayed: only `next`
//   messages are held. A reviewer session never gets one (0002).
// - A fix round (0002) is one held message of the round's first source, keyed on the pushed head
//   it answers; its feedback items point at the message's intent.

import type { Clock, RunId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { HostOp, SteerOp } from "../workers/types";

import { CONTROL_NOTICES } from "./control-types";
import { markFeedbackSent } from "./feedback-items";
import { type IntentSteering, markIntentSent, recordIntent, runIntents } from "./intents";
import type { StoredRun } from "./records";

/** The tag every feedback intent's detail starts with. */
export const FEEDBACK_TAG = "feedback";

/** The key of a message that answers nothing in particular. */
const NO_KEY = "-";

/** How a message is delivered: to the live session now, or with the next session. */
export type FeedbackVia = "now" | "next";

/** Where a message to the developer comes from (0002's one feedback path). */
export type FeedbackSource =
  /** A done report that does not parse or match the schema: its one correction turn (0008). */
  | "report"
  /** A valid done report the report gate refused: a test-plan miss or conflict markers (0002). */
  | "report-gate"
  /** A red verify in the box (0002). */
  | "verify"
  /** A conflict hand-off, or a merge of the base dipo made into the branch (0002). */
  | "conflict"
  /** Another story in progress changes the same files (0008). */
  | "overlap"
  /** A blocked review (0002). */
  | "review"
  /** Red required checks (0002). */
  | "ci"
  /** A maintainer reject (0002). */
  | "reject"
  /**
   * The reason's part of a resumed park's first message (0020). It carries no cap of its own: a
   * resume is bounded by the grants it records and the run's caps.
   */
  | "park"
  /** A resume note (0020). */
  | "resume"
  /** A maintainer steer (0020). */
  | "steer"
  /** The maintainer's answer to a worker question, held for the next session (0020). */
  | "answer";

/** One message for the developer session. */
export interface Feedback {
  readonly source: FeedbackSource;
  /** The message as the worker reads it. */
  readonly text: string;
  /** What the message is keyed on (a request id, an agent); none by default. No spaces. */
  readonly key?: string;
}

/** What sends a message to a live developer session now. */
export interface FeedbackSender {
  readonly steering: IntentSteering;
  /** The worker adapter's pure `encode`. */
  readonly encode: (op: SteerOp) => HostOp[];
  readonly clock: Pick<Clock, "now">;
}

/** A stored feedback intent, read back. */
export interface FeedbackIntent {
  readonly intentId: number;
  readonly source: string;
  readonly key: string;
  readonly via: FeedbackVia;
  readonly text: string;
  readonly state: string;
  readonly resolvedAt: number | null;
}

/** What `sendFeedback` did. */
export interface FeedbackSent {
  readonly intentId: number;
  /** `now` with a sender, else `next-session`. */
  readonly delivered: "now" | "next-session";
  /** Resolves with the host's failure reason, or null when it was sent or is held. */
  readonly done: Promise<string | null>;
}

/** The detail of a feedback intent. */
function detailOf(feedback: Feedback, via: FeedbackVia): string {
  const key = feedback.key ?? NO_KEY;
  if (key === "" || /\s/.test(key)) throw new Error(`a feedback key holds no spaces: ${key}`);
  return `${FEEDBACK_TAG} ${feedback.source} ${key} ${via} ${feedback.text}`;
}

/**
 * Pure: the source, key, delivery and text of a feedback intent's detail; null for any other
 * detail.
 */
export function parseFeedback(detail: string): {
  readonly source: string;
  readonly key: string;
  readonly via: FeedbackVia;
  readonly text: string;
} | null {
  const prefix = `${FEEDBACK_TAG} `;
  if (!detail.startsWith(prefix)) return null;
  const [source, key, via] = detail.slice(prefix.length).split(" ", 3);
  if (source === undefined || key === undefined || (via !== "now" && via !== "next")) {
    return null;
  }
  const head = `${prefix}${source} ${key} ${via}`;
  if (detail.length > head.length && detail[head.length] !== " ") return null;
  return { source, key, via, text: detail.slice(head.length + 1) };
}

/**
 * The one way dipo sends a developer session a message (see the file comment). The intent is stored
 * synchronously, so a caller may call this inside its own transaction when it passes no sender.
 * With `sender`, the message goes to the live session now; without, it waits for the run's next
 * developer session. `at` is when it is stored; the sender's clock by default.
 */
export function sendFeedback(
  office: OfficeHandle,
  runId: RunId | string,
  feedback: Feedback,
  options: { readonly sender?: FeedbackSender; readonly at?: number } = {},
): FeedbackSent {
  const { sender } = options;
  const at = options.at ?? sender?.clock.now();
  if (at === undefined) throw new Error("sendFeedback needs a time or a sender");
  const run = runId as RunId;
  const intentId = office.immediate(() =>
    recordIntent(
      office,
      run,
      "steer",
      detailOf(feedback, sender === undefined ? "next" : "now"),
      at,
    ),
  );
  if (sender === undefined) {
    return { intentId, delivered: "next-session", done: Promise.resolve(null) };
  }
  const done = (async (): Promise<string | null> => {
    let error: string | null = null;
    try {
      const sent = await sender.steering.send(
        office,
        run,
        sender.encode({ kind: "steer", text: feedback.text }),
      );
      if (!sent.ok) error = sent.reason;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const sentAt = sender.clock.now();
    office.immediate(() => markIntentSent(office, run, intentId, sentAt, error));
    return error;
  })();
  return { intentId, delivered: "now", done };
}

/** The run's feedback intents, oldest first; only those of `source` when it is given. */
export function feedbackIntents(
  office: OfficeHandle,
  runId: RunId | string,
  source?: FeedbackSource,
): FeedbackIntent[] {
  const out: FeedbackIntent[] = [];
  for (const intent of runIntents(office, runId as RunId)) {
    if (intent.kind !== "steer") continue;
    const parsed = parseFeedback(intent.detail);
    if (parsed === null || (source !== undefined && parsed.source !== source)) continue;
    out.push({
      intentId: intent.intentId,
      ...parsed,
      state: intent.state,
      resolvedAt: intent.resolvedAt,
    });
  }
  return out;
}

/** The steer stored for the request `request` (`key`), unless its send failed; `held` for `next`. */
export function findSteer(
  office: OfficeHandle,
  request: string,
): { readonly runId: string; readonly held: boolean } | null {
  const row = office.get<{ run_id: string; detail: string }>(
    `select run_id, detail from run_intents
      where office_id = $office_id and kind = 'steer' and state != 'failed'
        and detail like $prefix
      order by created_at desc limit 1`,
    { prefix: `${FEEDBACK_TAG} steer ${request} %` },
  );
  return row === null
    ? null
    : { runId: row.run_id, held: parseFeedback(row.detail)?.via === "next" };
}

/** The messages waiting for the run's next developer session, oldest first. */
export interface HeldFeedback {
  readonly ids: readonly number[];
  readonly texts: readonly string[];
}

/**
 * The maintainer's own words, which follow the findings in a first message (0020): a resume note,
 * a steer, and an answer to a worker question held for the next session.
 */
const MAINTAINER_WORDS: ReadonlySet<string> = new Set<FeedbackSource>([
  "resume",
  "steer",
  "answer",
]);

/**
 * The run's held messages: the findings and other code-built messages first, then the
 * maintainer's own words, each group oldest first (see the file comment).
 */
export function heldFeedback(office: OfficeHandle, runId: RunId | string): HeldFeedback {
  const pending = feedbackIntents(office, runId).filter(
    (item) => item.via === "next" && item.state === "pending",
  );
  const held = [
    ...pending.filter((item) => !MAINTAINER_WORDS.has(item.source)),
    ...pending.filter((item) => MAINTAINER_WORDS.has(item.source)),
  ];
  return { ids: held.map((item) => item.intentId), texts: held.map((item) => item.text) };
}

/**
 * Inside the caller's transaction, the one that records the session's agent: the held messages
 * `ids` went with its first message, and so did the feedback items they carry.
 */
export function deliverHeld(
  office: OfficeHandle,
  runId: RunId | string,
  ids: readonly number[],
  at: number,
): void {
  for (const id of ids) {
    office.run(
      `update run_intents set state = 'resolved', sent_at = $at, resolved_at = $at,
         outcome = 'resumed'
        where office_id = $office_id and run_id = $run and intent_id = $id and state = 'pending'`,
      { run: runId, id, at },
    );
    markFeedbackSent(office, runId, id, at);
  }
}

/** The `engine.notice` of a message that did not reach the run's live worker. */
export function notSentNotice(run: StoredRun, source: FeedbackSource, error: string): NewEntry {
  return {
    type: "engine.notice",
    ...(run.key === null ? {} : { key: run.key }),
    run: run.runId,
    delta: {
      level: "warn",
      code: CONTROL_NOTICES.feedbackNotSent,
      text: `${run.story ?? run.runId}: dipo could not send the ${source} feedback to its worker (${error}).`,
    },
  };
}
