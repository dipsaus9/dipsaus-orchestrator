// Retention as a feature (0007 section 7, DIPO-27 seam): a load step runs a pass when an office
// loads, then a timer runs one every hour while the office stays loaded. An office that is not
// loaded is cleaned at its next load. Passes of one office run one at a time; a failed pass is
// logged and never refuses the office.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";

import type { SummaryCheck } from "./run-files";
import { type RetentionReport, runRetention } from "./run";

/** The load step's name in the registry. */
export const RETENTION_STEP = "retention";

/** How often a loaded office runs retention (0007 section 7). */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionDeps {
  /**
   * The loaded offices: an hourly pass stops once its office is no longer loaded and reads the
   * configuration in force. Without it the passes use the configuration of the load.
   */
  readonly offices?: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** A pass appended entries (notices); subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /** Whether a run's summary exists; defaults to a `run_summaries` row. */
  readonly summarised?: SummaryCheck;
  /** Runs between batches; tests pass a no-op. */
  readonly pause?: () => Promise<void>;
  readonly intervalMs?: number;
}

interface Tracked {
  readonly office: OfficeHandle;
  readonly commonDir: string;
  readonly clock: Clock;
  config: OfficeConfig | undefined;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
}

export class Retention {
  readonly #deps: RetentionDeps;
  readonly #offices = new Map<OfficeId, Tracked>();
  #stopped = false;

  constructor(deps: RetentionDeps = {}) {
    this.#deps = deps;
  }

  /** The feature module that adds the `retention` load step. */
  get feature(): FeatureModule {
    return {
      name: "retention",
      register: (registry) => {
        registry.registerLoadStep(RETENTION_STEP, async (ctx) => {
          // Stopped: the daemon is closing the database, so no pass may start now.
          if (this.#stopped) return { ok: true };
          const state = this.#track(ctx.officeId, {
            office: ctx.office,
            commonDir: ctx.commonDir,
            clock: ctx.clock,
            config: ctx.config,
          });
          await this.#serial(state, () => this.#pass(ctx.officeId, state));
          this.#schedule(ctx.officeId, state);
          return { ok: true };
        });
      },
    };
  }

  /** One pass for a loaded office, after any pass already running. */
  run(office: OfficeId): Promise<RetentionReport | null> {
    const state = this.#offices.get(office);
    if (state === undefined) return Promise.resolve(null);
    return this.#serial(state, () => this.#pass(office, state));
  }

  /** Resolves once the office's running pass, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  /** Stops every timer and resolves once the passes already running have finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
    await Promise.all([...this.#offices.values()].map((state) => state.busy));
  }

  #track(office: OfficeId, values: Omit<Tracked, "timer" | "busy">): Tracked {
    const existing = this.#offices.get(office);
    if (existing !== undefined) this.#cancel(existing);
    const state: Tracked = { ...values, timer: null, busy: existing?.busy ?? Promise.resolve() };
    this.#offices.set(office, state);
    return state;
  }

  #serial<T>(state: Tracked, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  async #pass(office: OfficeId, state: Tracked): Promise<RetentionReport | null> {
    // A pass queued behind one that was running at `stop()` never starts.
    if (this.#stopped) return null;
    const config = state.config ?? OFFICE_DEFAULTS;
    try {
      const report = await runRetention({
        office: state.office,
        clock: state.clock,
        periods: config.retention,
        runFiles: {
          commonDir: state.commonDir,
          keepRawEvents: config.privacy.keepRawEvents,
          ...(this.#deps.summarised === undefined ? {} : { summarised: this.#deps.summarised }),
        },
        ...(this.#deps.pause === undefined ? {} : { pause: this.#deps.pause }),
      });
      if (report.notices > 0) this.#deps.onOfficeChanged?.(office);
      this.#deps.logger?.debug("retention pass", { office, ...report });
      return report;
    } catch (error) {
      this.#deps.logger?.warn("retention pass failed", {
        office,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  #schedule(office: OfficeId, state: Tracked): void {
    if (this.#stopped || state.timer !== null) return;
    // An office loaded again since has a new state with its own timer.
    if (this.#offices.get(office) !== state) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      const offices = this.#deps.offices;
      if (offices !== undefined) {
        if (offices.get(office) !== state.office) {
          if (this.#offices.get(office) === state) this.#offices.delete(office);
          return;
        }
        state.config = offices.config(office) ?? state.config;
      }
      void this.#serial(state, () => this.#pass(office, state)).finally(() =>
        this.#schedule(office, state),
      );
    }, this.#deps.intervalMs ?? RETENTION_INTERVAL_MS);
  }

  #cancel(state: Tracked): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }
}
