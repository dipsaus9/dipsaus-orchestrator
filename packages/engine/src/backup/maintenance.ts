// Daily file maintenance (0007 sections 1 and 7), only while no office has active work:
// `PRAGMA incremental_vacuum(N)` in slices of a few hundred pages, `PRAGMA optimize` and
// `PRAGMA wal_checkpoint(TRUNCATE)` on the whole file, each within the 50 ms budget. Idleness is asked again
// before every step; work that starts in between stops the rest until the next day.

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { Logger } from "../log/logger";
import type { SqliteConnection } from "../platform/sqlite";
import { Slicer, SLICE_BUDGET_MS } from "../retention/slices";

/** The largest incremental vacuum step, in pages. */
export const VACUUM_STEP_PAGES = 400;

/** Rows `PRAGMA optimize` may read per index, which bounds its time on a large file. */
export const ANALYSIS_LIMIT = 400;

export interface MaintenanceOptions {
  readonly connection: Pick<SqliteConnection, "get" | "all" | "exec">;
  readonly clock: Clock;
  /** True while no office has active work; asked before every step. */
  readonly idle: () => boolean;
  readonly logger?: Pick<Logger, "warn">;
  readonly budgetMs?: number;
  readonly pause?: () => Promise<void>;
}

export interface MaintenanceReport {
  readonly freedPages: number;
  readonly vacuumSteps: number;
  /** True when the TRUNCATE checkpoint ran to completion. */
  readonly checkpointed: boolean;
  readonly optimized: boolean;
  /** True when active work stopped maintenance before its end. */
  readonly interrupted: boolean;
  /** The slowest call of each step, in milliseconds. */
  readonly slowestMs: Readonly<Record<"vacuum" | "checkpoint" | "optimize", number>>;
}

export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceReport> {
  const { connection, clock, idle } = options;
  const budget = options.budgetMs ?? SLICE_BUDGET_MS;
  const slicer = new Slicer({
    clock,
    maxBatch: VACUUM_STEP_PAGES,
    budgetMs: budget,
    ...(options.pause === undefined ? {} : { pause: options.pause }),
  });
  const freelist = () =>
    connection.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count ?? 0;
  const timed = (step: "checkpoint" | "optimize", fn: () => void): number => {
    const started = clock.now();
    fn();
    const ms = Math.max(0, clock.now() - started);
    if (ms > budget) options.logger?.warn("maintenance step over budget", { step, ms, budget });
    return ms;
  };

  let freedPages = 0;
  let vacuumSteps = 0;
  let interrupted = false;
  for (let free = freelist(); free > 0;) {
    if (!idle()) {
      interrupted = true;
      break;
    }
    // `all` steps the pragma to completion; it frees one page per step.
    await slicer.slice((pages) => connection.all(`pragma incremental_vacuum(${pages})`));
    vacuumSteps += 1;
    const left = freelist();
    if (left >= free) break;
    freedPages += free - left;
    free = left;
  }
  if (slicer.slowestMs > budget) {
    options.logger?.warn("maintenance step over budget", {
      step: "vacuum",
      ms: slicer.slowestMs,
      budget,
    });
  }

  // `optimize` may write statistics, so it runs before the checkpoint that empties the WAL.
  let optimized = false;
  let optimizeMs = 0;
  if (!interrupted && idle()) {
    optimizeMs = timed("optimize", () => {
      connection.exec(`pragma analysis_limit = ${ANALYSIS_LIMIT}`);
      connection.all("pragma optimize");
    });
    optimized = true;
  } else {
    interrupted = true;
  }

  let checkpointed = false;
  let checkpointMs = 0;
  if (!interrupted && idle()) {
    checkpointMs = timed("checkpoint", () => {
      const row = connection.get<{ busy: number }>("pragma wal_checkpoint(TRUNCATE)");
      checkpointed = row?.busy === 0;
    });
  } else {
    interrupted = true;
  }

  return {
    freedPages,
    vacuumSteps,
    checkpointed,
    optimized,
    interrupted,
    slowestMs: { vacuum: slicer.slowestMs, checkpoint: checkpointMs, optimize: optimizeMs },
  };
}
