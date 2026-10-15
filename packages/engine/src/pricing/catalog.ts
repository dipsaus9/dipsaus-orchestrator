// The pricing catalogs the binary ships (0008 section 4, 0007 section 4). Each
// `catalog-<n>.json` lists per canonical model id the rates for input, output, 5 minute and
// 1 hour cache writes and cache reads, in micro-USD per million tokens, with the catalog's
// effective date and source URL. A released catalog is never edited: a new price is a new
// version. Its checksum is recorded here and in every database it was imported into, so a
// changed file fails at once, in tests and at daemon open.

import { createHash } from "node:crypto";

import { z } from "zod";

import catalog1 from "./catalog-1.json";
import catalog2 from "./catalog-2.json";

const Micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RatesSchema = z.strictObject({
  input: Micros,
  output: Micros,
  cacheWrite5m: Micros,
  cacheWrite1h: Micros,
  cacheRead: Micros,
});

/** Rates for one model; `longPrompt` applies to a request whose prompt is over `over` tokens. */
export const ModelRatesSchema = RatesSchema.extend({
  longPrompt: RatesSchema.extend({ over: z.number().int().positive() }).optional(),
});

export const CatalogSchema = z.strictObject({
  version: z.number().int().positive(),
  /** `yyyy-mm-dd`: the day the rates were read from `source`. */
  effectiveDate: z.iso.date(),
  source: z.url(),
  unit: z.literal("micro-USD per million tokens"),
  models: z.record(z.string().regex(/^[a-z0-9-]+$/), ModelRatesSchema),
});

export type Rates = z.infer<typeof RatesSchema>;
export type ModelRates = z.infer<typeof ModelRatesSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** A shipped catalog with the checksum it was released with. */
export interface ShippedCatalog {
  readonly catalog: unknown;
  readonly checksum: string;
}

/** sha256 over the catalog's JSON text as parsed, so a changed rate, id or field changes it. */
export function catalogChecksum(catalog: unknown): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

/** A shipped catalog differs from its released checksum, or from the version a database holds. */
export class CatalogChecksumError extends Error {
  constructor(
    readonly version: number,
    detail: string,
  ) {
    super(`Pricing catalog ${version} ${detail}; a released catalog is never edited.`);
    this.name = "CatalogChecksumError";
  }
}

/**
 * The catalogs compiled into the binary, oldest first. Append a new version with its checksum;
 * never edit or remove a released one.
 */
export const CATALOGS: readonly ShippedCatalog[] = [
  {
    catalog: catalog1,
    checksum: "57ad5daa9d1ec6298bedafcc40f043d902b63925de3cbfb17135415104bcb643",
  },
  // Read again from the pricing page on 2026-10-15 (DIPO-89): every rate of catalog 1 was still
  // current; the new version records that check.
  {
    catalog: catalog2,
    checksum: "bad1d98644fc7d232a36826ac0bcdf5a655b435b73fe0caeaef970665b661440",
  },
];

/** Parses a shipped catalog and checks it against its released checksum. */
export function verifyCatalog(shipped: ShippedCatalog): Catalog {
  const catalog = CatalogSchema.parse(shipped.catalog);
  const actual = catalogChecksum(shipped.catalog);
  if (actual !== shipped.checksum) {
    throw new CatalogChecksumError(
      catalog.version,
      `has checksum ${actual.slice(0, 12)}, not the released ${shipped.checksum.slice(0, 12)}`,
    );
  }
  return catalog;
}
