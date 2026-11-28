// The ticker (0009, DIPO-530, migration step 2): the latest events of the open office, newest
// first, each with the time it happened, `10:41 merged DIPO-444  ·  10:40 DIPO-447 → merge`. A run
// result goes to it as an event. A message that needs answering now (a refusal, a status, `press q
// again to quit`) still replaces it for as long as it shows.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { Clock, Event } from "@dipsaus-orchestrator/contract";
import { useEffect, useState } from "react";

import type { Display } from "./options";
import { clockTime, glyphs } from "./views";

/** One event of the ticker. */
export interface TickerEvent {
  /** When it happened, in milliseconds. */
  readonly at: number;
  readonly text: string;
  /** Events of one group in a row on the same minute are one: `reviewer raised 2 proposals`. */
  readonly group?: {
    readonly key: string;
    readonly count: number;
    readonly text: (n: number) => string;
  };
}

/** The events the ticker keeps; the line shows as many as fit. */
export const TICKER_KEEP = 8;

const RAISERS: Readonly<Record<string, string>> = {
  finding: "reviewer",
  proposal: "worker",
  aside: "planner",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The ticker's event for an office event, or null for one that is not worth a line. */
export function tickerEvent(event: Event, arrow: string): TickerEvent | null {
  const at = Date.parse(event.at);
  if (Number.isNaN(at)) return null;
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "story.state":
      return data.to === "Done" ? { at, text: `merged ${String(data.story)}` } : null;
    case "story.parked":
      return { at, text: `parked ${String(data.story)}: ${String(data.reason)}` };
    case "work.phase": {
      const work = data.work as { story?: unknown } | undefined;
      return work?.story === undefined
        ? null
        : { at, text: `${String(work.story)} ${arrow} ${String(data.phase)}` };
    }
    case "idea.passed": {
      const raiser = RAISERS[String(data.origin)];
      if (raiser === undefined) return null;
      return {
        at,
        text: `${raiser} raised 1 proposal`,
        group: {
          key: raiser,
          count: 1,
          text: (n) => `${raiser} raised ${plural(n, "proposal")}`,
        },
      };
    }
    default:
      return null;
  }
}

/** The log with `next` on top; a group's event on the same minute joins the one before it. */
export function pushEvent(log: readonly TickerEvent[], next: TickerEvent): TickerEvent[] {
  const top = log[0];
  if (
    next.group !== undefined &&
    top?.group?.key === next.group.key &&
    clockTime(top.at) === clockTime(next.at)
  ) {
    const count = top.group.count + 1;
    const merged = { ...top, text: next.group.text(count), group: { ...top.group, count } };
    return [merged, ...log.slice(1)];
  }
  return [next, ...log].slice(0, TICKER_KEEP);
}

/**
 * The ticker line: the newest events that fit in `width`, each `HH:MM text`, `separator` between;
 * the newest alone when even it does not fit. Null without events.
 */
export function tickerLine(
  log: readonly TickerEvent[],
  width: number,
  separator: string,
): string | null {
  let line: string | null = null;
  for (const event of log) {
    const part = `${clockTime(event.at)} ${event.text}`;
    const joined: string = line === null ? part : `${line}${separator}${part}`;
    if (line !== null && joined.length > width) break;
    line = joined;
  }
  return line;
}

/** A run's result, once it is done: one event, keyed by its request. */
export interface RunResultEvent {
  readonly id: string;
  readonly text: string;
}

/**
 * The ticker's log for `office`: office events as they come, and each run result once. It starts
 * over when another office opens.
 */
export function useTickerLog(options: {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly runResult: RunResultEvent | null;
}): readonly TickerEvent[] {
  const { store, clock, state, display, runResult } = options;
  const { office } = state;
  const arrow = glyphs(display.ascii).arrow;
  const [log, setLog] = useState<readonly TickerEvent[]>([]);
  useEffect(() => {
    setLog([]);
    return store.onOfficeEvent((event) => {
      const next = tickerEvent(event, arrow);
      if (next !== null) setLog((all) => pushEvent(all, next));
    });
  }, [store, office, arrow]);
  const id = runResult?.id;
  const text = runResult?.text;
  useEffect(() => {
    if (id === undefined || text === undefined) return;
    setLog((all) => pushEvent(all, { at: clock.now(), text }));
  }, [id]);
  return log;
}
