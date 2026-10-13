// Estimated cost (0008 section 4): tokens times the catalog's rates, summed per model, in
// micro-USD. Cost is an API-equivalent estimate shown next to plan-limit use, never a bill and
// never the budget (0007 section 4).
//
// A model priced by prompt length (DIPO-78) has rate sets beside its base rates; each applies to
// a request whose prompt (input plus cache writes plus cache reads) is over the set's `over`.

import type { Rates } from "./catalog";

/** Rates that apply to a request whose prompt is over `over` tokens. */
export interface PromptRates extends Rates {
  readonly over: number;
}

/** The rates of one imported catalog version, keyed by canonical model id. */
export interface PriceBook {
  /** The catalog version, as `usage_totals.pricing_version` stores it. */
  readonly version: string;
  /** Base rates (`pricing_rates.prompt_over = 0`). */
  readonly models: ReadonlyMap<string, Rates>;
  /** Long-prompt rate sets, ascending by `over`; a model without any is absent. */
  readonly longPrompt: ReadonlyMap<string, readonly PromptRates[]>;
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

/** The id the book lists a reported model under, or null when it does not list it. */
function bookKey(book: PriceBook, model: string): string | null {
  if (book.models.has(model)) return model;
  const canonical = canonicalModel(model);
  return book.models.has(canonical) ? canonical : null;
}

/**
 * The rates for a reported model id and a request's prompt size: the set with the highest `over`
 * below the prompt size, else the base rates. Without a prompt size, the base rates. Null when
 * the catalog does not list the model.
 */
export function ratesFor(book: PriceBook, model: string, prompt = 0): Rates | null {
  const key = bookKey(book, model);
  if (key === null) return null;
  let rates: Rates | null = book.models.get(key) ?? null;
  for (const set of book.longPrompt.get(key) ?? []) {
    if (prompt > set.over) rates = set;
  }
  return rates;
}

/** The long-prompt rate sets of a reported model id, ascending; empty when it has none. */
export function longPromptRates(book: PriceBook, model: string): readonly PromptRates[] {
  const key = bookKey(book, model);
  return key === null ? [] : (book.longPrompt.get(key) ?? []);
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

/** The estimate for one model's tokens at its base rates, or null when it has no rate. */
export function estimateMicros(
  book: PriceBook,
  model: string,
  tokens: PricedTokens,
): number | null {
  const rates = ratesFor(book, model);
  return rates === null ? null : costMicros(tokens, rates);
}

/** Message tokens that share one rate set. */
export interface PricedBand {
  readonly tokens: PricedTokens;
  readonly rates: Rates;
}

const FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cacheCreate5m", "cacheWrite5m"],
  ["cacheCreate1h", "cacheWrite1h"],
  ["cacheRead", "cacheRead"],
] as const;

/**
 * The sum of per-message estimates (DIPO-78), kept to the totals' tokens. Per field, each band of
 * messages is priced at its own rates; tokens the totals hold beyond the messages (spend with no
 * message, such as an aborted turn's) are priced at the base rates. When the messages hold more
 * of a field than the totals (live output, which totals take only from a turn end), the
 * messages' cost of that field is scaled down to the totals. Exact: one rounding, half up, at
 * the end, so a model with one rate set prices exactly as `costMicros` of the totals.
 */
export function messagesCostMicros(
  bands: readonly PricedBand[],
  totals: PricedTokens,
  base: Rates,
): number {
  let num = 0n;
  let den = 1n;
  for (const [token, rate] of FIELDS) {
    let counted = 0n;
    let priced = 0n;
    for (const band of bands) {
      const tokens = BigInt(band.tokens[token]);
      counted += tokens;
      priced += tokens * BigInt(band.rates[rate]);
    }
    const total = BigInt(totals[token]);
    const [fieldNum, fieldDen] =
      counted <= total
        ? [priced + (total - counted) * BigInt(base[rate]), 1n]
        : [priced * total, counted];
    num = num * fieldDen + fieldNum * den;
    den *= fieldDen;
  }
  const scale = den * MILLION;
  return Number((2n * num + scale) / (2n * scale));
}
