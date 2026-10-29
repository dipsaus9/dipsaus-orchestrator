// The engine watchdog (0008, 0009): for each running worker it writes the fact `no-output` with its
// `work.observed` when no line arrived for `timeouts.workerQuietMinutes` (health `quiet`), and marks
// it stuck with another `work.observed no-output` after `timeouts.workerStallMinutes` (health
// `stuck`), on the injected clock. Any line (ingestion calls `lineSeen`) starts both waits again;
// the ingestion pass that read the line clears the fact in its own transaction. Health is derived
// from the facts in effect, so it changes only through events (`views/work.ts`).

import type { Clock, OfficeId, RunId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { withWorkViews, workRefOf } from "../views/work";

import { findRun } from "./records";
import { markStuck, raiseSignal, type StoredSignal } from "./signals";

const MINUTE_MS = 60_000;

/** The office's `timeouts` the watchdog waits by, in minutes. */
export interface WatchdogTimeouts {
  readonly workerQuietMinutes: number;
  readonly workerStallMinutes: number;
}

export interface WatchdogOptions {
  readonly clock: Clock;
  /** The office's timeouts in force; the defaults of 0009 (3 and 20) when undefined. */
  readonly timeouts: (office: OfficeId) => WatchdogTimeouts | undefined;
  /** Entries were appended for `office`; the daemon sends them to subscribers. */
  readonly onAppended?: (office: OfficeId) => void;
}

/** The 0009 defaults: quiet after 3 minutes, stuck after 20. */
export const WATCHDOG_DEFAULTS: WatchdogTimeouts = {
  workerQuietMinutes: 3,
  workerStallMinutes: 20,
};

interface Watched {
  readonly office: OfficeHandle;
  readonly run: RunId;
  quiet: TimerHandle | null;
  stall: TimerHandle | null;
}

export class Watchdog {
  readonly #options: WatchdogOptions;
  readonly #runs = new Map<string, Watched>();

  constructor(options: WatchdogOptions) {
    this.#options = options;
  }

  /** Runs being watched. */
  get watching(): number {
    return this.#runs.size;
  }

  /** Starts watching a run whose worker just started: both waits begin now. */
  track(office: OfficeHandle, run: RunId): void {
    if (this.#runs.has(run)) return;
    const watched: Watched = { office, run, quiet: null, stall: null };
    this.#runs.set(run, watched);
    this.#arm(watched);
  }

  /** A line of the run arrived: both waits begin again. Unknown runs are ignored. */
  lineSeen(run: string): void {
    const watched = this.#runs.get(run);
    if (watched === undefined) return;
    this.#clear(watched);
    this.#arm(watched);
  }

  /** Stops watching a run, for example when its worker exited. */
  untrack(run: string): void {
    const watched = this.#runs.get(run);
    if (watched === undefined) return;
    this.#clear(watched);
    this.#runs.delete(run);
  }

  /** Stops every timer; the signals already written stay. */
  close(): void {
    for (const watched of this.#runs.values()) this.#clear(watched);
    this.#runs.clear();
  }

  #arm(watched: Watched): void {
    const timeouts = this.#options.timeouts(watched.office.officeId) ?? WATCHDOG_DEFAULTS;
    const { clock } = this.#options;
    watched.quiet = clock.setTimeout(() => {
      watched.quiet = null;
      this.#raise(watched, false);
    }, timeouts.workerQuietMinutes * MINUTE_MS);
    watched.stall = clock.setTimeout(() => {
      watched.stall = null;
      this.#raise(watched, true);
    }, timeouts.workerStallMinutes * MINUTE_MS);
  }

  #clear(watched: Watched): void {
    const { clock } = this.#options;
    if (watched.quiet !== null) clock.clearTimeout(watched.quiet);
    if (watched.stall !== null) clock.clearTimeout(watched.stall);
    watched.quiet = null;
    watched.stall = null;
  }

  /**
   * Writes `no-output`, or marks it stuck when `stuck`, with its `work.observed`, once each; a run
   * that ended is no longer watched.
   */
  #raise(watched: Watched, stuck: boolean): void {
    const { office, run } = watched;
    const at = this.#options.clock.now();
    const written = office.immediate(() => {
      const stored = findRun(office, run);
      if (stored === null || stored.endedAt !== null) return "ended";
      const work = workRefOf(office, run);
      if (work === null) return "none";
      const fact: StoredSignal | null = stuck
        ? markStuck(office, run, at)
        : raiseSignal(office, run, "no-output", at);
      if (fact === null) return "none";
      appendEntries(
        office,
        withWorkViews(office, [
          {
            type: "work.observed",
            key: work.key,
            run,
            delta: { work, signal: fact.signal, since: new Date(fact.since).toISOString() },
          },
        ]),
        { at },
      );
      return "written";
    });
    if (written === "ended") this.untrack(run);
    if (written === "written") this.#options.onAppended?.(office.officeId);
  }
}
