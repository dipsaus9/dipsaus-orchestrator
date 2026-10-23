// Send-once feedback (0019 section 8, DIPO-148): the facts of `feedback_items`, read and written
// through the office handle. Writers run inside the caller's transaction, the one that stores the
// steer intent carrying the items, so a restart neither loses nor repeats one.
//
// - Send-once. An item is stored at most once per pushed head commit (the table's unique key on
//   run, signature and head): a second poll, a restart or a second CI run on the same head sends
//   nothing new. The same signature on a later head is a repeat: it is sent again, marked.
// - Same failure. Two sends in a row of one verify or CI signature (the run's two newest fix
//   rounds both carry it) raise the watchdog signal `same-failure` (0009). A repeat never parks on
//   its own; parks come from the caps.
// - Delivered. A row's `sent_at` is set when the session that carries its intent started; until
//   then the round's feedback waits with its intent (a fix round the pre-start cap check parked
//   keeps it for a top-up resume, DIPO-156).

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import {
  capFeedbackText,
  type FeedbackSource,
  type FixItem,
  type FixRoundItem,
} from "../prompts/feedback";

/** An item planned for a head: new for it, and maybe a repeat of an earlier head's. */
export interface PlannedItem extends FixItem {
  readonly repeat: boolean;
}

/** One stored row of `feedback_items`. */
export interface StoredFeedbackItem extends FixRoundItem {
  readonly itemId: number;
  readonly signature: string;
  readonly head: string;
  readonly round: number;
  readonly intentId: number;
  readonly sentAt: number | null;
  readonly createdAt: number;
}

interface ItemRow {
  item_id: number;
  source: FeedbackSource;
  signature: string;
  head_sha: string;
  round: number;
  repeat: number;
  intent_id: number;
  sent_at: number | null;
  text: string;
  created_at: number;
}

const COLUMNS =
  "item_id, source, signature, head_sha, round, repeat, intent_id, sent_at, text, created_at";

function toItem(row: ItemRow): StoredFeedbackItem {
  return {
    itemId: row.item_id,
    source: row.source,
    signature: row.signature,
    head: row.head_sha,
    round: row.round,
    repeat: row.repeat === 1,
    intentId: row.intent_id,
    sentAt: row.sent_at,
    text: row.text,
    createdAt: row.created_at,
  };
}

/** The run's stored feedback items, oldest first. */
export function feedbackItems(office: OfficeHandle, runId: RunId | string): StoredFeedbackItem[] {
  return office
    .all<ItemRow>(
      `select ${COLUMNS} from feedback_items where office_id = $office_id and run_id = $run
        order by item_id`,
      { run: runId },
    )
    .map(toItem);
}

/** The items the intent `intentId` carries, in their order. */
export function feedbackOfIntent(
  office: OfficeHandle,
  runId: RunId | string,
  intentId: number,
): StoredFeedbackItem[] {
  return office
    .all<ItemRow>(
      `select ${COLUMNS} from feedback_items where office_id = $office_id and run_id = $run
        and intent_id = $intent order by item_id`,
      { run: runId, intent: intentId },
    )
    .map(toItem);
}

/**
 * The items of `items` not yet stored for `head`, each marked a repeat when its signature was
 * stored for another head of the run. Duplicates within `items` are kept once.
 */
export function planFeedback(
  office: OfficeHandle,
  runId: RunId | string,
  head: string,
  items: readonly FixItem[],
): PlannedItem[] {
  const seen = new Set<string>();
  const planned: PlannedItem[] = [];
  for (const item of items) {
    if (seen.has(item.signature)) continue;
    seen.add(item.signature);
    const heads = office
      .all<{ head_sha: string }>(
        `select head_sha from feedback_items where office_id = $office_id and run_id = $run
          and signature = $signature`,
        { run: runId, signature: item.signature },
      )
      .map((row) => row.head_sha);
    if (heads.includes(head)) continue;
    planned.push({ ...item, repeat: heads.length > 0 });
  }
  return planned;
}

/** The number of the run's next fix round: one more than the rounds it stored items for. */
export function nextFixRound(office: OfficeHandle, runId: RunId | string): number {
  return (
    (office.get<{ n: number | null }>(
      `select max(round) as n from feedback_items where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.n ?? 0) + 1
  );
}

/**
 * True when one verify or CI signature of `planned` was carried by the run's newest fix round
 * stored so far: two sends in a row of the same failure (0019 section 8, `same-failure`).
 */
export function sameFailureAgain(
  office: OfficeHandle,
  runId: RunId | string,
  planned: readonly PlannedItem[],
): boolean {
  const last = office.get<{ round: number | null }>(
    `select max(round) as round from feedback_items where office_id = $office_id and run_id = $run`,
    { run: runId },
  )?.round;
  if (last == null) return false;
  const previous = new Set(
    office
      .all<{ signature: string }>(
        `select signature from feedback_items where office_id = $office_id and run_id = $run
          and round = $round and source in ('verify', 'ci')`,
        { run: runId, round: last },
      )
      .map((row) => row.signature),
  );
  return planned.some(
    (item) => (item.source === "verify" || item.source === "ci") && previous.has(item.signature),
  );
}

/**
 * Inside the caller's transaction, the one that stores the steer intent `intentId`: the planned
 * items of fix round `round` for `head`, in order, with their rendered text within the per-item
 * budget. Returns what was stored.
 */
export function storeFeedbackItems(
  office: OfficeHandle,
  runId: RunId | string,
  input: {
    readonly intentId: number;
    readonly head: string;
    readonly round: number;
    readonly items: readonly PlannedItem[];
    readonly at: number;
  },
): StoredFeedbackItem[] {
  let next =
    office.get<{ id: number }>(
      `select coalesce(max(item_id), 0) + 1 as id from feedback_items
        where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.id ?? 1;
  for (const item of input.items) {
    office.run(
      `insert into feedback_items (office_id, run_id, item_id, source, signature, head_sha, round,
         repeat, intent_id, sent_at, text, created_at)
       values ($office_id, $run, $id, $source, $signature, $head, $round, $repeat, $intent, null,
         $text, $at)`,
      {
        run: runId,
        id: next,
        source: item.source,
        signature: item.signature,
        head: input.head,
        round: input.round,
        repeat: item.repeat ? 1 : 0,
        intent: input.intentId,
        text: capFeedbackText(item.text),
        at: input.at,
      },
    );
    next += 1;
  }
  return feedbackOfIntent(office, runId, input.intentId);
}

/** Inside the caller's transaction: the items of `intentId` reached a session at `at`. */
export function markFeedbackSent(
  office: OfficeHandle,
  runId: RunId | string,
  intentId: number,
  at: number,
): void {
  office.run(
    `update feedback_items set sent_at = $at where office_id = $office_id and run_id = $run
      and intent_id = $intent and sent_at is null`,
    { run: runId, intent: intentId, at },
  );
}
