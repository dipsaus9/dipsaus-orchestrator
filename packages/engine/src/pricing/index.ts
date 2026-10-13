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
// - Rates are applied per message (DIPO-78). A message whose prompt (input plus 5 minute and
//   1 hour cache writes plus cache reads) is over a long-prompt threshold (`pricing_rates.
//   prompt_over`, Claude Haiku 5.5 over 100,000 tokens) is priced at that set's rates; a prompt
//   of exactly the threshold is not over it. A totals row's estimate is the sum of its messages'
//   estimates, not a re-pricing of its aggregated tokens.
// - Tokens the totals hold beyond the sum of their messages have no message, so no prompt size,
//   and are priced at base rates. That is the spend of an aborted turn (stored as 5 minute
//   writes, above), output the turn end reports beyond the messages' own output (per-message
//   output may be a placeholder, so a long prompt's output can be priced partly at base rates),
//   and the messages retention removed after `retention.shortDays` while their agent still runs.
//   While the messages hold more of a field than the totals (live output before the first turn
//   end), the messages' cost of that field is scaled down to the totals.
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
  longPromptRates,
  messagesCostMicros,
  ratesFor,
  type PriceBook,
  type PricedBand,
  type PricedTokens,
  type PromptRates,
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
