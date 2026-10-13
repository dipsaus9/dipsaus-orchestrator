// The pricing module (DIPO-62; 0008 section 4, 0007 section 4): versioned catalogs shipped in
// the binary, their import at daemon open, and the estimated cost of stored usage.
//
// Notes, known approximations:
//
// - Cache writes are priced from `cache_create_5m` and `cache_create_1h` as stored, never from
//   a split of `cache_create` (their sum, DIPO-45). The 1 hour part comes from the per-message
//   `usage.cache_creation` split. When the adapter's turn-end totals report more cache creation
//   than the counted messages (an aborted turn's spend), the rest is stored as 5 minute writes,
//   so the estimate can be slightly low for sessions that write mostly to the 1 hour cache.
// - Rates are applied to run totals, not per request. A model priced by prompt length (Claude
//   Haiku 5.5 above 100,000 prompt tokens) is estimated at its base rates; the catalog keeps the
//   long-prompt rates (`pricing_rates.prompt_over`), but they are not applied yet.
// - The CLI's `costUSD` is itself a client-side estimate; the cross-check only flags a gap above
//   10%, it does not correct the estimate.
// - Model ids are matched exactly, then with a `[1m]` marker and a `-yyyymmdd` snapshot suffix
//   dropped. A model the catalog lacks keeps a null estimate and counts as 0 in the cross-check.

export {
  CATALOGS,
  CatalogChecksumError,
  CatalogSchema,
  catalogChecksum,
  verifyCatalog,
  type Catalog,
  type ModelRates,
  type Rates,
  type ShippedCatalog,
} from "./catalog";
export {
  canonicalModel,
  costMicros,
  estimateMicros,
  ratesFor,
  type PriceBook,
  type PricedTokens,
} from "./estimate";
export { importCatalogs, loadPriceBook, type ImportResult } from "./import";
export {
  CATALOG_GAP_LIMIT,
  CATALOG_STALE_CODE,
  checkCatalogGap,
  costGap,
  priceAgentUsage,
  recordCliCost,
} from "./usage";
