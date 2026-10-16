// Pricing of stored usage (0008 section 4, 0007 section 4). Each update of an agent's
// `usage_totals` rows refreshes their `est_cost_micros` and `pricing_version` in the same
// transaction; a model the catalog does not list keeps both null. A row's estimate is the sum of
// its `usage_messages` estimates, each at the rates of the message's prompt size (DIPO-78), so
// the per-day and office sums built from these rows also sum per-message estimates and never
// re-price aggregated tokens. At a turn end the run's estimate is compared with the CLI's own
// `costUSD`; a gap above 10% raises one `engine.notice` per run that the catalog may be stale.
//
// Every function here must run inside the caller's transaction.

import type { RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { Rates } from "./catalog";
import {
  canonicalModel,
  costMicros,
  longPromptRates,
  messagesCostMicros,
  ratesFor,
  type PriceBook,
  type PricedBand,
  type PricedTokens,
} from "./estimate";

/** The engine notice code of a possibly stale catalog. */
export const CATALOG_STALE_CODE = "pricing.catalogStale";

/** The largest gap between estimate and CLI cost that raises no notice (0008 section 4). */
export const CATALOG_GAP_LIMIT = 0.1;

interface PricedRow {
  model: string;
  input: number;
  output: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cache_read: number;
}

type TokenRow = Omit<PricedRow, "model">;

const NO_TOKENS: TokenRow = {
  input: 0,
  output: 0,
  cache_create_5m: 0,
  cache_create_1h: 0,
  cache_read: 0,
};

function tokensOf(row: TokenRow): PricedTokens {
  // cache_create_5m and cache_create_1h are read as stored, never a split of the total.
  return {
    input: row.input,
    output: row.output,
    cacheCreate5m: row.cache_create_5m,
    cacheCreate1h: row.cache_create_1h,
    cacheRead: row.cache_read,
  };
}

/** A message's prompt size: input plus cache writes (5 minute and 1 hour) plus cache reads. */
const PROMPT = "input + cache_create_5m + cache_create_1h + cache_read";

/**
 * The message model ids a totals row is priced from (DIPO-89): its own id when messages carry
 * it, else every id of the same canonical model. Turn totals may key a model with a `[1m]` marker
 * while its messages carry the plain id the API answered with.
 */
function messageModels(office: OfficeHandle, run: string, agent: string, model: string): string[] {
  const ids = office
    .all<{ model: string }>(
      `select distinct model from usage_messages
       where office_id = $office_id and agent_id = $agent and run_id = $run`,
      { agent, run },
    )
    .map((message) => message.model);
  if (ids.includes(model)) return [model];
  const canonical = canonicalModel(model);
  return ids.filter((id) => canonicalModel(id) === canonical);
}

/**
 * The estimate of one totals row (DIPO-78): the sum of its messages' estimates, each message at
 * the rates its prompt size selects, plus the totals' tokens beyond the messages at base rates.
 * A model with only base rates prices its totals directly, which equals that sum exactly.
 */
function rowCost(
  office: OfficeHandle,
  book: PriceBook,
  run: string,
  agent: string,
  row: PricedRow,
): number | null {
  const base = ratesFor(book, row.model);
  if (base === null) return null;
  const totals = tokensOf(row);
  const sets = longPromptRates(book, row.model);
  if (sets.length === 0) return costMicros(totals, base);
  // One band per rate set: prompts over the set's `over`, up to and including the next one's.
  const bands: { over: number; rates: Rates }[] = [
    { over: -1, rates: base },
    ...sets.map((set) => ({ over: set.over, rates: set })),
  ];
  const models = JSON.stringify(messageModels(office, run, agent, row.model));
  const priced: PricedBand[] = bands.map((band, index) => {
    const sums = office.get<TokenRow>(
      `select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output,
         coalesce(sum(cache_create_5m), 0) as cache_create_5m,
         coalesce(sum(cache_create_1h), 0) as cache_create_1h,
         coalesce(sum(cache_read), 0) as cache_read
       from usage_messages
       where office_id = $office_id and agent_id = $agent and run_id = $run
         and model in (select value from json_each($models))
         and ${PROMPT} > $over and ${PROMPT} <= $upTo`,
      {
        agent,
        run,
        models,
        over: band.over,
        upTo: bands[index + 1]?.over ?? Number.MAX_SAFE_INTEGER,
      },
    );
    return { tokens: tokensOf(sums ?? NO_TOKENS), rates: band.rates };
  });
  return messagesCostMicros(priced, totals, base);
}

/** Recomputes the estimated cost of every model row of one run and agent. */
export function priceAgentUsage(
  office: OfficeHandle,
  book: PriceBook | null,
  run: string,
  agent: string,
): void {
  if (book === null) return;
  const rows = office.all<PricedRow>(
    `select model, input, output, cache_create_5m, cache_create_1h, cache_read
     from usage_totals where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { run, agent },
  );
  for (const row of rows) {
    const cost = rowCost(office, book, run, agent, row);
    office.run(
      `update usage_totals set est_cost_micros = $cost, pricing_version = $version
       where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
      { cost, version: cost === null ? null : book.version, run, agent, model: row.model },
    );
  }
}

/**
 * Stores the CLI's run-cumulative `costUSD` per model of one agent, from a turn end. A turn end
 * without one (no cost reported, or the CLI's cost no longer covers the counted spend) clears the
 * agent's CLI cost, so the cross-check leaves the agent out. Returns the models whose cost
 * matched no usage row (0 rows changed), for the caller to warn about.
 */
export function recordCliCost(
  office: OfficeHandle,
  run: string,
  agent: string,
  costUsd: Readonly<Record<string, number>> | null,
): string[] {
  if (costUsd === null) {
    office.run(
      `update usage_totals set cli_cost_micros = null
       where office_id = $office_id and run_id = $run and agent_id = $agent`,
      { run, agent },
    );
    return [];
  }
  const missing: string[] = [];
  for (const [model, dollars] of Object.entries(costUsd)) {
    const updated = office.run(
      `update usage_totals set cli_cost_micros = $micros
       where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
      { micros: Math.round(dollars * 1_000_000), run, agent, model },
    );
    if (updated.changes === 0) missing.push(model);
  }
  return missing;
}

/** The relative gap between an estimate and the CLI cost it is checked against. */
export function costGap(estimate: number, cli: number): number {
  return cli === 0 ? 0 : Math.abs(estimate - cli) / cli;
}

/**
 * Compares the run's estimate with the CLI's cost over the rows where the CLI reported one; a
 * model the catalog lacks counts as an estimate of 0. Returns the one `engine.notice` to append
 * when the gap is above 10% and the run has not raised it before, else null.
 */
export function checkCatalogGap(
  office: OfficeHandle,
  book: PriceBook | null,
  run: string,
  work: WorkRef | undefined,
  at: number,
): NewEntry | null {
  if (book === null) return null;
  const sums = office.get<{ est: number | null; cli: number | null; unpriced: string | null }>(
    `select sum(coalesce(est_cost_micros, 0)) as est, sum(cli_cost_micros) as cli,
       group_concat(case when est_cost_micros is null then model end, ', ') as unpriced
     from usage_totals
     where office_id = $office_id and run_id = $run and cli_cost_micros is not null`,
    { run },
  );
  const est = sums?.est ?? 0;
  const cli = sums?.cli ?? 0;
  if (cli <= 0 || costGap(est, cli) <= CATALOG_GAP_LIMIT) return null;
  const raised = office.run(
    `insert or ignore into pricing_checks (office_id, run_id, est_cost_micros, cli_cost_micros,
       pricing_version, raised_at)
     values ($office_id, $run, $est, $cli, $version, $at)`,
    { run, est, cli, version: book.version, at },
  );
  if (raised.changes === 0) return null;
  const percent = Math.round(costGap(est, cli) * 100);
  const unpriced = sums?.unpriced ?? null;
  return {
    type: "engine.notice",
    ...(work === undefined ? {} : { key: work.key }),
    run: run as RunId,
    delta: {
      level: "warn",
      code: CATALOG_STALE_CODE,
      text:
        `The estimated cost of ${run} (${usd(est)}, pricing catalog ${book.version}) differs ` +
        `${percent}% from the CLI's own cost (${usd(cli)}); the pricing catalog may be stale.` +
        (unpriced === null ? "" : ` The catalog has no rates for ${unpriced}.`),
    },
  };
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
