// Cost drift per model (DIPO-89): when an agent finishes, each of its models whose estimate and
// CLI cost differ by more than 10% is logged as one warn line, at most once per model and day,
// so a later price change shows up in the log instead of as a silent gap. The per-run
// `engine.notice` of `checkCatalogGap` stays; this line names the model.

import type { OfficeHandle } from "../db/office";
import { utcDay } from "../ingest/usage";
import { canonicalModel } from "./estimate";
import { CATALOG_GAP_LIMIT, costGap } from "./usage";

/** One model of a finished agent whose estimate drifts from the CLI cost. */
export interface CostDrift {
  readonly model: string;
  readonly estimateMicros: number;
  readonly cliMicros: number;
  /** The catalog version of the estimate (`usage_totals.pricing_version`). */
  readonly catalogVersion: string;
}

/**
 * The models of one agent whose estimate and CLI cost both exist and differ by more than 10%.
 * Must run inside the caller's transaction.
 */
export function agentCostDrifts(office: OfficeHandle, run: string, agent: string): CostDrift[] {
  return office
    .all<{ model: string; est: number; cli: number; version: string }>(
      `select model, est_cost_micros as est, cli_cost_micros as cli, pricing_version as version
       from usage_totals
       where office_id = $office_id and run_id = $run and agent_id = $agent
         and est_cost_micros is not null and cli_cost_micros is not null
         and pricing_version is not null and cli_cost_micros > 0
       order by model`,
      { run, agent },
    )
    .filter((row) => costGap(row.est, row.cli) > CATALOG_GAP_LIMIT)
    .map((row) => ({
      model: row.model,
      estimateMicros: row.est,
      cliMicros: row.cli,
      catalogVersion: row.version,
    }));
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/**
 * Remembers which models were warned about today (UTC, on the injected clock's time), by
 * canonical id so `claude-opus-5-5` and `claude-opus-5-5[1m]` count as one; the line keeps the
 * id as stored. Each model is warned about once per day across all offices: one instance is
 * shared by every office's ingestor. It lives as long as the daemon, so a restart may warn again
 * the same day.
 */
export class CostDriftWarnings {
  #day = "";
  readonly #warned = new Set<string>();

  /**
   * Logs each drift whose model was not yet warned about on the day of `at`, through `warn`.
   * Returns the drifts it logged.
   */
  report(
    drifts: readonly CostDrift[],
    at: number,
    warn: (message: string, fields: Readonly<Record<string, unknown>>) => void,
    context: Readonly<Record<string, unknown>> = {},
  ): CostDrift[] {
    const day = utcDay(at);
    if (day !== this.#day) {
      this.#day = day;
      this.#warned.clear();
    }
    const logged: CostDrift[] = [];
    for (const drift of drifts) {
      const key = canonicalModel(drift.model);
      if (this.#warned.has(key)) continue;
      this.#warned.add(key);
      const percent = Math.round(costGap(drift.estimateMicros, drift.cliMicros) * 100);
      warn(
        `estimated cost of ${drift.model} (${usd(drift.estimateMicros)}, pricing catalog ` +
          `${drift.catalogVersion}) differs ${percent}% from the CLI cost ` +
          `(${usd(drift.cliMicros)})`,
        {
          ...context,
          model: drift.model,
          estimateUsd: drift.estimateMicros / 1_000_000,
          cliUsd: drift.cliMicros / 1_000_000,
          catalogVersion: drift.catalogVersion,
          gapPercent: percent,
        },
      );
      logged.push(drift);
    }
    return logged;
  }
}
