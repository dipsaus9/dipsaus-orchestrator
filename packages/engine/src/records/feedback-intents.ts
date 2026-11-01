// The stored form of the one feedback path's messages (`run/feedback.ts`, 0002, 0020): each is a
// `steer` intent whose detail is `feedback <source> <key> <via> <text>`. This is the one reader of
// that detail, in the records layer so a run's end can close what it left open (DIPO-412).

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { runIntents } from "./intents";
import type { StoredRun } from "./run-records";

/** The tag every feedback intent's detail starts with. */
export const FEEDBACK_TAG = "feedback";

/** How a message is delivered: to the live session now, or with the next session. */
export type FeedbackVia = "now" | "next";

/** The `engine.notice` code of a run that ended with a steer its worker never read (DIPO-412). */
export const STEER_UNREAD_NOTICE = "run.steerUnread";

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

/** The run's feedback intents, oldest first; only those of `source` when it is given. */
export function feedbackIntents(
  office: OfficeHandle,
  runId: RunId | string,
  source?: string,
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

/**
 * Inside the caller's transaction, as `run` ends `done` or `dropped` (DIPO-412): every steer of
 * the run no session read or carried, held or sent, is resolved `unread`, so none stays open
 * after its run. Returns the `engine.notice` that says so, or none.
 */
export function closeUnreadSteers(
  office: OfficeHandle,
  run: Pick<StoredRun, "runId" | "key" | "story">,
  at: number,
): NewEntry[] {
  const open = feedbackIntents(office, run.runId, "steer").filter(
    (item) => item.state === "pending" || item.state === "sent",
  );
  for (const item of open) {
    office.run(
      `update run_intents set state = 'resolved', resolved_at = $at, outcome = 'unread'
        where office_id = $office_id and run_id = $run and intent_id = $id`,
      { run: run.runId, id: item.intentId, at },
    );
  }
  if (open.length === 0) return [];
  const steers =
    open.length === 1 ? "the maintainer's steer" : `${open.length} of the maintainer's steers`;
  return [
    {
      type: "engine.notice",
      ...(run.key === null ? {} : { key: run.key }),
      run: run.runId,
      delta: {
        level: "warn",
        code: STEER_UNREAD_NOTICE,
        text: `${run.story ?? run.runId}: the run ended before its worker read ${steers}.`,
      },
    },
  ];
}
