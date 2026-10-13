// Estimated cost (0008 section 4): tokens times the catalog's rates, summed per model, in
// micro-USD. Cost is an API-equivalent estimate shown next to plan-limit use, never a bill and
// never the budget (0007 section 4).

import type { Rates } from "./catalog";

/** The rates of one imported catalog version, keyed by canonical model id. */
export interface PriceBook {
  /** The catalog version, as `usage_totals.pricing_version` stores it. */
  readonly version: string;
  readonly models: ReadonlyMap<string, Rates>;
}

/** Tokens of one model, with cache creation split into its 5 minute and 1 hour parts. */
export interface PricedTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheCreate5m: number;
  readonly cacheCreate1h: number;
  readonly cacheRead: number;
}

const DATE_SUFFIX = /-\d{8}$/;
const CONTEXT_SUFFIX = /\[[^\]]*\]$/;

/**
 * The canonical id a reported model id is priced under: a context-window marker (`[1m]`) and a
 * snapshot date suffix (`-20250929`) are dropped, so `claude-sonnet-4-5-20250929` prices as
 * `claude-sonnet-4-5`.
 */
export function canonicalModel(model: string): string {
  return model.trim().toLowerCase().replace(CONTEXT_SUFFIX, "").replace(DATE_SUFFIX, "");
}

/** The rates for a reported model id, or null when the catalog does not list it. */
export function ratesFor(book: PriceBook, model: string): Rates | null {
  return book.models.get(model) ?? book.models.get(canonicalModel(model)) ?? null;
}

const MILLION = 1_000_000n;

/**
 * Micro-USD for the tokens at the given per-million rates, rounded half up. Exact: the products
 * are summed as integers before the one division, so the result equals a hand computation.
 */
export function costMicros(tokens: PricedTokens, rates: Rates): number {
  const sum =
    BigInt(tokens.input) * BigInt(rates.input) +
    BigInt(tokens.output) * BigInt(rates.output) +
    BigInt(tokens.cacheCreate5m) * BigInt(rates.cacheWrite5m) +
    BigInt(tokens.cacheCreate1h) * BigInt(rates.cacheWrite1h) +
    BigInt(tokens.cacheRead) * BigInt(rates.cacheRead);
  return Number((sum + MILLION / 2n) / MILLION);
}

/** The estimate for one model's tokens, or null when the catalog has no rate for the model. */
export function estimateMicros(
  book: PriceBook,
  model: string,
  tokens: PricedTokens,
): number | null {
  const rates = ratesFor(book, model);
  return rates === null ? null : costMicros(tokens, rates);
}
