// The renderer (0005 section 6): stored entries become contract events when they are sent, not
// when they are written. The entry carries the view its writer computed, so rendering never derives
// status; a contract change rewrites this module, never the stored log (0005 section 11).

import { type Cursor, type Event, findEvent, type OfficeId } from "@dipsaus-orchestrator/contract";

import { cursorAt } from "./cursor";
import type { StoredEntry } from "./log";

/** Builds an event's `data` from a stored entry. */
export type RenderFn = (entry: StoredEntry) => unknown;

/** What the default rendering reads of an entry; a new entry has these before it is stored. */
export type RenderInput = Pick<StoredEntry, "type" | "delta" | "view">;

/** A stored entry that does not render into a valid contract event: an engine bug. */
export class RenderError extends Error {
  constructor(
    readonly type: string,
    readonly seq: number,
    detail: string,
  ) {
    super(`Change-log entry ${seq} (${type}) does not render: ${detail}.`);
    this.name = "RenderError";
  }
}

/**
 * The notice code sent in place of a stored entry that does not render (DIPO-124): the subscriber
 * gets this `engine.notice` at the entry's own cursor, so its cursor moves past the entry and the
 * stream stays gap-free instead of closing and replaying the same entry for good.
 */
export const UNRENDERABLE_NOTICE_CODE = "changelog.unrenderable";

function hasViewField(type: string): boolean {
  const data = findEvent(type)?.data as { shape?: Record<string, unknown> } | undefined;
  return data?.shape !== undefined && "view" in data.shape;
}

/**
 * The default rendering: the delta is the event data, and for an event whose data has a `view`
 * field (such as `story.state`) the view stored on the entry fills it.
 */
export const renderDelta = (entry: RenderInput): unknown => {
  if (entry.view !== undefined && hasViewField(entry.type)) {
    return { ...(entry.delta as Record<string, unknown>), view: entry.view };
  }
  return entry.delta;
};

type Parsed =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly detail: string };

function parseData(type: string, data: unknown): Parsed {
  const definition = findEvent(type);
  if (definition === undefined) return { ok: false, detail: "the contract has no such event type" };
  const parsed = definition.data.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, detail: parsed.error.message };
}

/**
 * Why `entry` would not render by default into valid event data, or undefined when it would: the
 * check `appendEntries` makes before it stores an entry (DIPO-124).
 */
export function renderProblem(entry: RenderInput): string | undefined {
  const parsed = parseData(entry.type, renderDelta(entry));
  return parsed.ok ? undefined : parsed.detail;
}

/** The `engine.notice` sent in place of a stored entry that does not render (DIPO-124). */
export function unrenderableNotice(office: OfficeId, epoch: string, entry: StoredEntry): Event {
  return {
    cursor: cursorAt(office, epoch, entry.seq),
    at: new Date(entry.at).toISOString(),
    type: "engine.notice",
    data: {
      level: "error",
      code: UNRENDERABLE_NOTICE_CODE,
      text: `Change-log entry ${entry.seq} (${entry.type}) does not render, so this fact is missing from the stream; reopening the office, or a reconnect after stream.resetRequired, shows the current state.`,
    },
  };
}

export class Renderer {
  readonly #overrides: ReadonlyMap<string, RenderFn>;

  /** `overrides` replaces the default rendering for the event types it names. */
  constructor(overrides: Readonly<Record<string, RenderFn>> = {}) {
    this.#overrides = new Map(Object.entries(overrides));
  }

  /** One event for one entry of `office`'s log; throws `RenderError` if it does not parse. */
  render(office: OfficeId, epoch: string, entry: StoredEntry): Event {
    const render = this.#overrides.get(entry.type) ?? renderDelta;
    const parsed = parseData(entry.type, render(entry));
    if (!parsed.ok) throw new RenderError(entry.type, entry.seq, parsed.detail);
    const cursor: Cursor = cursorAt(office, epoch, entry.seq);
    return {
      cursor,
      at: new Date(entry.at).toISOString(),
      type: entry.type,
      ...(entry.causedBy === undefined ? {} : { causedBy: entry.causedBy }),
      data: parsed.data,
    };
  }

  renderAll(office: OfficeId, epoch: string, entries: readonly StoredEntry[]): Event[] {
    return entries.map((entry) => this.render(office, epoch, entry));
  }

  /**
   * The events a subscriber gets for `entries`. An entry that does not render (one an older binary
   * stored before `appendEntries` checked entries) becomes `unrenderableNotice` at its own cursor
   * and `onUnrenderable` hears why, so replay always moves past it (DIPO-124). Any other error
   * (not a `RenderError`) is thrown, so the stream fails as it did before.
   */
  renderForStream(
    office: OfficeId,
    epoch: string,
    entries: readonly StoredEntry[],
    onUnrenderable: (error: RenderError, entry: StoredEntry) => void,
  ): Event[] {
    return entries.map((entry) => {
      try {
        return this.render(office, epoch, entry);
      } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        onUnrenderable(error, entry);
        return unrenderableNotice(office, epoch, entry);
      }
    });
  }
}
