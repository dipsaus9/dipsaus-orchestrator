// When the daily backup and maintenance run (0007 sections 7 and 10). The daemon checks every hour,
// starting a minute after it reaches `running`:
//
// - Backup: once per UTC day while no office has active work, and at the latest 24 hours after the
//   newest daily copy even with work running (`VACUUM INTO` in a Worker takes no write lock).
// - Maintenance: once per UTC day, only while no office has active work.
//
// Checks run one at a time; `stop` waits for the running one, so the daemon closes the database
// only after it.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { Logger } from "../log/logger";
import { DAY_MS } from "../retention/run";

import { type DailyBackupResult, type VacuumInto, writeDailyBackup } from "./daily";
import {
  type BackupCounts,
  backupsDirectory,
  dailyBackupName,
  newestDailyBackupAt,
  utcDay,
} from "./files";
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
  readonly counts?: BackupCounts;
  readonly vacuum?: VacuumInto;
  readonly pause?: () => Promise<void>;
  readonly intervalMs?: number;
  readonly firstDelayMs?: number;
}

export interface CheckReport {
  readonly backup: DailyBackupResult | null;
  readonly maintenance: MaintenanceReport | null;
}

export class MaintenanceScheduler {
  readonly #deps: MaintenanceSchedulerDeps;
  #timer: TimerHandle | null = null;
  #stopped = false;
  #running: Promise<CheckReport> | null = null;
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

  /** One check; a check already running is joined instead of starting a second one. */
  check(): Promise<CheckReport> {
    if (this.#running !== null) return this.#running;
    const run = this.#check().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  /** Whether today's backup is due at `now`. */
  backupDue(db: StateDatabase, now: number, idle: boolean): boolean {
    const dir = backupsDirectory(db.connection.path);
    const newest = newestDailyBackupAt(dir);
    if (newest === null || now - newest >= DAY_MS) return true;
    return idle && !existsSync(join(dir, dailyBackupName(now)));
  }

  async #check(): Promise<CheckReport> {
    const { clock, logger } = this.#deps;
    const db = this.#deps.database();
    if (db === null || this.#stopped) return { backup: null, maintenance: null };
    // Stopping, or another database, ends the work between slices.
    const idle = () => !this.#stopped && this.#deps.database() === db && this.#deps.idle();

    let backup: DailyBackupResult | null = null;
    const now = clock.now();
    if (this.backupDue(db, now, idle())) {
      try {
        backup = await writeDailyBackup({
          dbPath: db.connection.path,
          now,
          ...(this.#deps.counts === undefined ? {} : { counts: this.#deps.counts }),
          ...(this.#deps.vacuum === undefined ? {} : { vacuum: this.#deps.vacuum }),
        });
        if (backup.written) {
          logger.info("wrote daily backup", { path: backup.path, removed: backup.removed });
        }
      } catch (error) {
        logger.error("daily backup failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let maintenance: MaintenanceReport | null = null;
    const day = utcDay(clock.now());
    if (this.#maintainedDay !== day && idle()) {
      try {
        maintenance = await runMaintenance({
          connection: db.connection,
          clock,
          idle,
          logger,
          ...(this.#deps.pause === undefined ? {} : { pause: this.#deps.pause }),
        });
        if (!maintenance.interrupted) this.#maintainedDay = day;
        logger.info("database maintenance", { ...maintenance });
      } catch (error) {
        logger.error("database maintenance failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { backup, maintenance };
  }

  #arm(delayMs: number): void {
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      void this.check().finally(() => {
        if (!this.#stopped) this.#arm(this.#deps.intervalMs ?? MAINTENANCE_CHECK_MS);
      });
    }, delayMs);
  }
}
