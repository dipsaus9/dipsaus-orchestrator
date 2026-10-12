// The renderer (0005 section 6): stored entries become contract events when they are sent, not
// when they are written. The entry carries the view its writer computed, so rendering never derives
// status; a contract change rewrites this module, never the stored log (0005 section 11).

import { type Cursor, type Event, findEvent, type OfficeId } from "@dipsaus-orchestrator/contract";

import { cursorAt, type StoredEntry } from "./log";

/** Builds an event's `data` from a stored entry. */
export type RenderFn = (entry: StoredEntry) => unknown;

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

function hasViewField(type: string): boolean {
  const data = findEvent(type)?.data as { shape?: Record<string, unknown> } | undefined;
  return data?.shape !== undefined && "view" in data.shape;
}

/**
 * The default rendering: the delta is the event data, and for an event whose data has a `view`
 * field (such as `story.state`) the view stored on the entry fills it.
 */
export const renderDelta: RenderFn = (entry) => {
  if (entry.view !== undefined && hasViewField(entry.type)) {
    return { ...(entry.delta as Record<string, unknown>), view: entry.view };
  }
  return entry.delta;
};

export class Renderer {
  readonly #overrides: ReadonlyMap<string, RenderFn>;

  /** `overrides` replaces the default rendering for the event types it names. */
  constructor(overrides: Readonly<Record<string, RenderFn>> = {}) {
    this.#overrides = new Map(Object.entries(overrides));
  }

  /** One event for one entry of `office`'s log; throws `RenderError` if it does not parse. */
  render(office: OfficeId, epoch: string, entry: StoredEntry): Event {
    const definition = findEvent(entry.type);
    if (definition === undefined) {
      throw new RenderError(entry.type, entry.seq, "the contract has no such event type");
    }
    const render = this.#overrides.get(entry.type) ?? renderDelta;
    const parsed = definition.data.safeParse(render(entry));
    if (!parsed.success) {
      throw new RenderError(entry.type, entry.seq, parsed.error.message);
    }
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
}
