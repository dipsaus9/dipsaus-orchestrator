// Catalog import at daemon open (0007 section 4): every shipped catalog version the database
// lacks is imported once, after its checksum is verified. A version already imported is compared
// by checksum and never written again; the schema's triggers refuse any edit of it.

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { SqliteConnection, SqlRunner } from "../platform/sqlite";
import {
  CATALOGS,
  CatalogChecksumError,
  verifyCatalog,
  type Rates,
  type ShippedCatalog,
} from "./catalog";
import type { PriceBook, PromptRates } from "./estimate";

export interface ImportResult {
  /** Versions imported by this call. */
  readonly imported: readonly number[];
}

function insertRates(
  db: SqlRunner,
  version: number,
  model: string,
  promptOver: number,
  rates: Rates,
): void {
  db.run(
    `insert into pricing_rates (version, model, prompt_over, input, output, cache_write_5m,
       cache_write_1h, cache_read)
     values ($version, $model, $over, $input, $output, $w5m, $w1h, $read)`,
    {
      version,
      model,
      over: promptOver,
      input: rates.input,
      output: rates.output,
      w5m: rates.cacheWrite5m,
      w1h: rates.cacheWrite1h,
      read: rates.cacheRead,
    },
  );
}

/**
 * Imports the shipped catalogs the database lacks, in one transaction. Throws
 * `CatalogChecksumError` when a shipped catalog differs from its released checksum or from the
 * version the database already holds; nothing is imported then.
 */
export function importCatalogs(
  db: SqliteConnection,
  clock: Clock,
  catalogs: readonly ShippedCatalog[] = CATALOGS,
): ImportResult {
  const verified = catalogs.map((shipped) => ({
    shipped,
    catalog: verifyCatalog(shipped),
  }));
  const imported: number[] = [];
  db.immediate(() => {
    for (const { shipped, catalog } of verified) {
      const stored = db.get<{ checksum: string }>(
        "select checksum from pricing_catalogs where version = $version",
        { version: catalog.version },
      );
      if (stored !== null) {
        if (stored.checksum !== shipped.checksum) {
          throw new CatalogChecksumError(
            catalog.version,
            `has checksum ${shipped.checksum.slice(0, 12)} in this binary, but ${stored.checksum.slice(0, 12)} was imported`,
          );
        }
        continue;
      }
      db.run(
        `insert into pricing_catalogs (version, source, effective_date, checksum, imported_at)
         values ($version, $source, $date, $checksum, $at)`,
        {
          version: catalog.version,
          source: catalog.source,
          date: catalog.effectiveDate,
          checksum: shipped.checksum,
          at: clock.now(),
        },
      );
      for (const [model, rates] of Object.entries(catalog.models)) {
        insertRates(db, catalog.version, model, 0, rates);
        if (rates.longPrompt !== undefined) {
          insertRates(db, catalog.version, model, rates.longPrompt.over, rates.longPrompt);
        }
      }
      imported.push(catalog.version);
    }
  });
  return { imported };
}

interface RateRow {
  model: string;
  prompt_over: number;
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

/**
 * Every rate set of the newest imported catalog (DIPO-78): the base rates (`prompt_over = 0`)
 * and each long-prompt set, or null when no catalog is imported. Long-prompt sets of a model
 * without base rates are left out, so the model prices as unknown.
 */
export function loadPriceBook(db: SqlRunner): PriceBook | null {
  const latest = db.get<{ version: number | null }>(
    "select max(version) as version from pricing_catalogs",
  );
  if (latest?.version === null || latest?.version === undefined) return null;
  const rows = db.all<RateRow>(
    `select model, prompt_over, input, output, cache_write_5m, cache_write_1h, cache_read
     from pricing_rates where version = $version order by model, prompt_over`,
    { version: latest.version },
  );
  const models = new Map<string, Rates>();
  const longPrompt = new Map<string, PromptRates[]>();
  for (const row of rows) {
    const rates: Rates = {
      input: row.input,
      output: row.output,
      cacheWrite5m: row.cache_write_5m,
      cacheWrite1h: row.cache_write_1h,
      cacheRead: row.cache_read,
    };
    if (row.prompt_over === 0) {
      models.set(row.model, rates);
    } else if (models.has(row.model)) {
      // Rows come ordered by prompt_over, so the base row of a model is always seen first.
      longPrompt.set(row.model, [
        ...(longPrompt.get(row.model) ?? []),
        { ...rates, over: row.prompt_over },
      ]);
    }
  }
  return { version: String(latest.version), models, longPrompt };
}
