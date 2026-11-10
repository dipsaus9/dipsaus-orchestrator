// When the daily database upkeep runs (0007). The daemon checks every hour, starting a minute after
// it reaches `running`, and runs the upkeep once per UTC day, only while no office has active work:
// incremental vacuum in slices, a truncating checkpoint and `PRAGMA optimize`.
//
// Checks run one at a time; `stop` waits for the running one, so the daemon closes the database
// only after it. A timer's check runs as a background job (DIPO-110, DIPO-119): a failure outside
// the upkeep itself is one logged line with its error code, and the next check is still armed.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { Logger } from "../log/logger";
import { background } from "../platform/background";

import { type MaintenanceReport, runMaintenance } from "./maintenance";

export const MAINTENANCE_CHECK_MS = 60 * 60 * 1000;
export const MAINTENANCE_FIRST_CHECK_MS = 60 * 1000;

export interface MaintenanceSchedulerDeps {
  /** The state database once recovery opened it; null before. */
  readonly database: () => StateDatabase | null;
  readonly clock: Clock;
  /** True while no office has active work. */
  readonly idle: () => boolean;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly pause?: () => Promise<void>;
  readonly intervalMs?: number;
  readonly firstDelayMs?: number;
}

/** `yyyy-mm-dd` of `ms` in UTC. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class MaintenanceScheduler {
  readonly #deps: MaintenanceSchedulerDeps;
  #timer: TimerHandle | null = null;
  #stopped = false;
  #running: Promise<MaintenanceReport | null> | null = null;
  #maintainedDay: string | null = null;

  constructor(deps: MaintenanceSchedulerDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#arm(this.#deps.firstDelayMs ?? MAINTENANCE_FIRST_CHECK_MS);
  }

  /** Stops the timer and resolves once a running check has finished. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => undefined);
  }

  /**
   * One check: the upkeep when today's has not run and no office has active work, else null. A
   * check already running is joined instead of starting a second one.
   */
  check(): Promise<MaintenanceReport | null> {
    if (this.#running !== null) return this.#running;
    const run = this.#check().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #check(): Promise<MaintenanceReport | null> {
    const { clock, logger } = this.#deps;
    const db = this.#deps.database();
    if (db === null || this.#stopped) return null;
    // Stopping, or another database, ends the work between slices.
    const idle = () => !this.#stopped && this.#deps.database() === db && this.#deps.idle();
    const day = utcDay(clock.now());
    if (this.#maintainedDay === day || !idle()) return null;
    try {
      const maintenance = await runMaintenance({
        connection: db.connection,
        clock,
        idle,
        logger,
        ...(this.#deps.pause === undefined ? {} : { pause: this.#deps.pause }),
      });
      if (!maintenance.interrupted) this.#maintainedDay = day;
      logger.info("database maintenance", { ...maintenance });
      return maintenance;
    } catch (error) {
      logger.error("database maintenance failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  #arm(delayMs: number): void {
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      background(() => this.check(), {
        failed: "the database maintenance check failed",
        log: (message, fields) => this.#deps.logger.warn(message, fields),
        settled: () => {
          if (!this.#stopped) this.#arm(this.#deps.intervalMs ?? MAINTENANCE_CHECK_MS);
        },
      });
    }, delayMs);
  }
}
