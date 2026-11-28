// What the office is busy with or waits on outside story runs (DIPO-527): `office.snapshot`'s
// `background` and the `background.changed` event. Six kinds: story PRs after their run, the lane's
// backlog PR, open tests, the audit, the chat and the daemon's own work.
//
// - The facts come from the records where the records hold them (the backlog PR, the open tests,
//   the held ideas and the audit run) and from the board, a cache the producers write to where only
//   memory holds them (a story PR's CI watch, the chat, the daemon's update). A daemon start
//   leaves the board empty until the producers write again, as `rememberPr` does for the lane.
// - The engine sets the order (failed, needs-you, running, waiting, done, each in the order of
//   its kind and ref) and drops a done item `BACKGROUND_DONE_KEEP_MS` after it finished.
// - `next` is a line code builds from facts, never an estimate (decision 24); a time dipo itself
//   scheduled (`retries at 10:35`) is a fact.

import {
  BACKGROUND_STATES,
  type BackgroundItem,
  type BackgroundKind,
  type BackgroundState,
  type LaneCi,
  type LaneProgress,
  type TestView,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { OfficeHandle } from "../db/office";
import { AUDITOR_ROLE } from "../records/caps";
import { openTestViews } from "../run/test-records";

/** The event a change travels in. */
export const BACKGROUND_EVENT = "background.changed";

/** How long a done item stays listed. */
export const BACKGROUND_DONE_KEEP_MS = 10 * 60_000;

/** A story PR after its run, as its CI watch last read it (DIPO-527). */
export interface StoryPrFact {
  readonly key: string;
  readonly number: number;
  readonly url: string;
  readonly ci: LaneCi;
  /** The failed required check, when one is named. */
  readonly failedCheck?: string;
  /** The CI attempt this head is and the run's cap, when it has one. */
  readonly attempt?: number;
  readonly of?: number;
  /** When dipo itself scheduled the next attempt, in ms. */
  readonly retryAt?: number;
  readonly autoMerge?: boolean;
  /** GitHub shows the PR merged and dipo has not closed its record yet. */
  readonly merged?: boolean;
  /** Since when the PR stands in this state, in ms. */
  readonly since: number;
}

/** An item a producer posts as it is: the chat's and the daemon's (DIPO-527). */
export interface PostedItem {
  readonly kind: BackgroundKind;
  readonly ref: string;
  readonly subject: string;
  readonly state: BackgroundState;
  readonly next?: string;
  /** In ms. */
  readonly since: number;
  readonly url?: string;
}

interface Board {
  readonly prs: Map<number, StoryPrFact>;
  readonly posted: Map<string, PostedItem>;
  /** The state and line last sent for each item, by `kind ref`. */
  readonly sent: Map<string, string>;
  /** The lane as its writers last saw it: what an event's entries read of the backlog PR. */
  lane: LaneProgress | null;
}

const boards = new WeakMap<OfficeHandle, Board>();

function boardOf(office: OfficeHandle): Board {
  let board = boards.get(office);
  if (board === undefined) {
    board = { prs: new Map(), posted: new Map(), sent: new Map(), lane: null };
    boards.set(office, board);
  }
  return board;
}

/** Keeps the lane's view the backlog PR's item is built from in the entries. */
export function rememberLane(office: OfficeHandle, lane: LaneProgress | null): void {
  boardOf(office).lane = lane;
}

/**
 * Keeps what the CI watch read of a story PR; true when it differs from what was kept. `since` is
 * when the PR entered its CI state, so a read that says the same keeps the first.
 */
export function rememberStoryPr(office: OfficeHandle, fact: StoryPrFact): boolean {
  const prs = boardOf(office).prs;
  const before = prs.get(fact.number);
  if (before !== undefined && before.ci === fact.ci && before.attempt === fact.attempt) {
    if (before.failedCheck === fact.failedCheck && before.retryAt === fact.retryAt) return false;
  }
  const entered = before !== undefined && before.ci === fact.ci ? before.since : fact.since;
  prs.set(fact.number, { ...fact, since: entered });
  return true;
}

/** Forgets a story PR whose record closed. */
export function forgetStoryPr(office: OfficeHandle, number: number): void {
  boardOf(office).prs.delete(number);
}

/** Posts the chat's or the daemon's item; the same kind and ref replaces the earlier one. */
export function postBackground(office: OfficeHandle, item: PostedItem): void {
  boardOf(office).posted.set(`${item.kind} ${item.ref}`, item);
}

/** Takes an item the producer no longer has. */
export function clearBackground(office: OfficeHandle, kind: BackgroundKind, ref: string): void {
  boardOf(office).posted.delete(`${kind} ${ref}`);
}

const iso = (ms: number): string => new Date(ms).toISOString();

const twoDigits = (n: number): string => String(n).padStart(2, "0");

/** `HH:MM` in the machine's time, as the screens show a time. */
export function clockTime(ms: number): string {
  const at = new Date(ms);
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

function storyPrItem(fact: StoryPrFact): BackgroundItem {
  const ref = `PR #${fact.number}`;
  const base = { kind: "story-pr", ref, since: iso(fact.since), url: fact.url } as const;
  if (fact.merged === true) {
    return { ...base, subject: `${fact.key} merged`, state: "done", ci: fact.ci };
  }
  if (fact.ci === "failed") {
    const attempt =
      fact.attempt === undefined || fact.of === undefined
        ? ""
        : ` · attempt ${fact.attempt} of ${fact.of}`;
    const check = fact.failedCheck === undefined ? "" : `: ${fact.failedCheck}`;
    const left = fact.attempt === undefined || fact.of === undefined || fact.attempt < fact.of;
    const goes = fact.of === undefined ? "" : `; after attempt ${fact.of} it goes to your Desk`;
    return {
      ...base,
      subject: `${fact.key} · CI failed${check}${attempt}`,
      state: "failed",
      ci: "failed",
      next: !left
        ? "no attempts left; it is on your Desk"
        : fact.retryAt === undefined
          ? `dipo fixes it${goes}`
          : `retries at ${clockTime(fact.retryAt)}${goes}`,
    };
  }
  if (fact.ci === "passed") {
    return {
      ...base,
      subject: `${fact.key} · CI passed`,
      state: "waiting",
      ci: "passed",
      next: fact.autoMerge === true ? "auto-merges now" : "waits for its merge gate",
    };
  }
  return {
    ...base,
    subject: `${fact.key} · CI ${fact.ci === "running" ? "running" : "not read yet"}`,
    state: "running",
    ci: fact.ci,
    ...(fact.autoMerge === true ? { next: "auto-merges when green" } : {}),
  };
}

function backlogPrItem(lane: LaneProgress, now: number): BackgroundItem | null {
  const pr = lane.pr;
  if (pr === undefined) return null;
  const since = lane.ops.map((op) => Date.parse(op.since)).reduce((a, b) => Math.min(a, b), now);
  const changes = `${lane.ops.length} ${lane.ops.length === 1 ? "change" : "changes"}`;
  const base = { kind: "backlog-pr", ref: `PR #${pr.number}`, url: pr.url, ci: pr.ci } as const;
  const ci = pr.ci === "unknown" ? "CI not read yet" : `CI ${pr.ci}`;
  const subject = `backlog PR · ${changes} · ${ci}`;
  if (pr.merged) {
    return { ...base, subject: "backlog PR merged", state: "done", since: iso(now) };
  }
  if (pr.ci === "failed") {
    return {
      ...base,
      subject,
      state: "failed",
      next: "its changes wait; the check failed",
      since: iso(since),
    };
  }
  return {
    ...base,
    subject,
    state: pr.ci === "passed" && !pr.autoMerge ? "waiting" : "running",
    next: pr.autoMerge ? "auto-merges when green" : "waits for auto-merge to be set",
    since: iso(since),
  };
}

function testItem(view: TestView): BackgroundItem {
  const at = Date.parse(view.startedAt);
  return {
    kind: "test",
    ref: view.test,
    subject: `${view.key} at ${view.head.slice(0, 7)} · box up · ${view.steps.length} ${
      view.steps.length === 1 ? "step" : "steps"
    }`,
    state: "needs-you",
    next: `waits on you since ${clockTime(at)}`,
    since: view.startedAt,
    ...(view.url === undefined ? {} : { url: view.url }),
  };
}

function auditItem(office: OfficeHandle, now: number): BackgroundItem | null {
  const held = office.get<{ n: number; first: number | null }>(
    `select count(*) as n, min(created_at) as first from ideas
      where office_id = $office_id and state = 'held'`,
  );
  const running = office.get<{ started_at: number }>(
    `select started_at from runs where office_id = $office_id and kind = 'session'
        and role = $role and ended_at is null order by started_at limit 1`,
    { role: AUDITOR_ROLE },
  );
  const count = held?.n ?? 0;
  if (count === 0 && running === null) return null;
  const ideas = `${count} ${count === 1 ? "idea" : "ideas"} held`;
  return running === null
    ? {
        kind: "audit",
        ref: "audit",
        subject: ideas,
        state: "waiting",
        next: "waits for an audit session",
        since: iso(held?.first ?? now),
      }
    : {
        kind: "audit",
        ref: "audit",
        subject: ideas,
        state: "running",
        next: `audit running since ${clockTime(running.started_at)}`,
        since: iso(running.started_at),
      };
}

function postedItem(item: PostedItem): BackgroundItem {
  return {
    kind: item.kind,
    ref: item.ref,
    subject: item.subject,
    state: item.state,
    ...(item.next === undefined ? {} : { next: item.next }),
    since: iso(item.since),
    ...(item.url === undefined ? {} : { url: item.url }),
  };
}

const rankOf = (item: BackgroundItem): number => BACKGROUND_STATES.indexOf(item.state);

/** Failed first, then done last; within a state by kind and ref, so the order is the same on every read. */
export function orderBackground(items: readonly BackgroundItem[]): BackgroundItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .toSorted(
      (a, b) =>
        rankOf(a.item) - rankOf(b.item) ||
        (a.item.kind < b.item.kind ? -1 : a.item.kind > b.item.kind ? 1 : 0) ||
        (a.item.ref < b.item.ref ? -1 : a.item.ref > b.item.ref ? 1 : 0) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/** Pure: the items still listed at `now`: a done item goes ten minutes after its `since`. */
export function listedBackground(items: readonly BackgroundItem[], now: number): BackgroundItem[] {
  return orderBackground(
    items.filter(
      (item) => item.state !== "done" || now - Date.parse(item.since) < BACKGROUND_DONE_KEEP_MS,
    ),
  );
}

/** Every item the facts say at `now`, a done one too, in the engine's order. */
function gatherBackground(
  office: OfficeHandle,
  now: number,
  lane: LaneProgress | null,
): BackgroundItem[] {
  const board = boardOf(office);
  const items: BackgroundItem[] = [...board.prs.values()].map(storyPrItem);
  const backlog = lane === null ? null : backlogPrItem(lane, now);
  if (backlog !== null) items.push(backlog);
  items.push(...openTestViews(office).map(testItem));
  const audit = auditItem(office, now);
  if (audit !== null) items.push(audit);
  items.push(...Array.from(board.posted.values(), postedItem));
  return orderBackground(items);
}

/** Everything the office runs or waits on outside story runs at `now`, in the engine's order. */
export function backgroundItems(
  office: OfficeHandle,
  now: number,
  lane: LaneProgress | null,
): BackgroundItem[] {
  return listedBackground(gatherBackground(office, now, lane), now);
}

/** The snapshot's view: absent while nothing is listed. */
export function snapshotBackground(
  office: OfficeHandle,
  now: number,
  lane: LaneProgress | null,
): BackgroundItem[] | null {
  const items = backgroundItems(office, now, lane);
  return items.length === 0 ? null : items;
}

const WORDS: Readonly<Record<BackgroundState, string>> = {
  failed: "failed",
  "needs-you": "needs you",
  running: "running",
  waiting: "waiting",
  done: "done",
};

/** The ticker line of an item that changed: code builds it from the item's own words. */
export function tickerLine(item: BackgroundItem): string {
  return `${item.ref} ${item.subject} (${WORDS[item.state]})`;
}

/**
 * The `background.changed` entries to append: one for each item that is new or whose state, subject
 * or next line differs from the one last sent; runs inside the caller's transaction, after the
 * change it follows. An item that went from the list sends nothing and is forgotten.
 */
export function backgroundEntries(office: OfficeHandle, now: number): NewEntry[] {
  const board = boardOf(office);
  // A done item's leaving the list is no change: the entries read every item.
  const items = gatherBackground(office, now, board.lane);
  const seen = new Set<string>();
  const entries: NewEntry[] = [];
  for (const item of items) {
    const id = `${item.kind} ${item.ref}`;
    seen.add(id);
    const signature = JSON.stringify([item.state, item.subject, item.next ?? null]);
    if (board.sent.get(id) === signature) continue;
    board.sent.set(id, signature);
    entries.push({ type: BACKGROUND_EVENT, delta: { item, line: tickerLine(item) } });
  }
  for (const id of board.sent.keys()) if (!seen.has(id)) board.sent.delete(id);
  return entries;
}

/** The daemon's item for dipo's own update. */
const UPDATE_REF = "update";

function postUpdate(
  office: OfficeHandle,
  at: number,
  item: Pick<PostedItem, "subject" | "state" | "next">,
): void {
  postBackground(office, { kind: "daemon", ref: UPDATE_REF, since: at, ...item });
  office.immediate(() => appendEntries(office, backgroundEntries(office, at), { at }));
}

/**
 * Runs dipo's update of `office` and keeps the daemon's item for it: running while it builds, and
 * afterwards what came of it. A refusal lists with its reason, and a failure with its message
 * (DIPO-527); the error goes on to the caller as it was.
 */
export async function trackUpdate<R extends { readonly commit: string }>(
  office: OfficeHandle | undefined,
  now: () => number,
  run: () => Promise<R>,
): Promise<R> {
  if (office === undefined) return await run();
  postUpdate(office, now(), { subject: "dipo is building an update", state: "running" });
  try {
    const result = await run();
    postUpdate(office, now(), {
      subject: `dipo built ${result.commit} and restarts`,
      state: "done",
    });
    return result;
  } catch (error) {
    if (error instanceof CommandError && error.error.code === "update.refused") {
      const details = error.error.details as { reason?: string } | undefined;
      postUpdate(office, now(), {
        subject: `dipo update refused: ${details?.reason ?? "refused"}`,
        state: "waiting",
        next: error.message,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      postUpdate(office, now(), { subject: "dipo update failed", state: "failed", next: message });
    }
    throw error;
  }
}
