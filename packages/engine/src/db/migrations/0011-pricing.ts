// Migration 11 (DIPO-62): the pricing catalogs (0007 section 4, 0008 section 4).
//
// `pricing_catalogs` and `pricing_rates` are software-wide (0007 section 3) and kept forever. A
// catalog version is imported once from the binary and never edited: triggers refuse updates and
// deletes. Rates are micro-USD per million tokens; `prompt_over` is 0 for the base rates and the
// prompt length above which a long-prompt row applies (Claude Haiku 5.5).
//
// `usage_totals.cli_cost_micros` keeps the CLI's own `costUSD` per run, agent and model beside
// the estimate (0008 section 4). `pricing_checks` records the one stale-catalog notice per run.

import type { SqlMigration } from "../migrations";

export const pricing: SqlMigration = {
  version: 11,
  name: "pricing_catalogs, pricing_rates and pricing_checks",
  sql: `
create table pricing_catalogs (
  version integer primary key,
  source text not null,
  effective_date text not null,
  checksum text not null,
  imported_at integer not null
) strict;

create table pricing_rates (
  version integer not null references pricing_catalogs (version),
  model text not null,
  prompt_over integer not null default 0,
  input integer not null,
  output integer not null,
  cache_write_5m integer not null,
  cache_write_1h integer not null,
  cache_read integer not null,
  primary key (version, model, prompt_over)
) strict;

create trigger pricing_catalogs_no_update before update on pricing_catalogs
begin select raise(abort, 'an imported pricing catalog is never edited'); end;
create trigger pricing_catalogs_no_delete before delete on pricing_catalogs
begin select raise(abort, 'an imported pricing catalog is never edited'); end;
create trigger pricing_rates_no_update before update on pricing_rates
begin select raise(abort, 'an imported pricing catalog is never edited'); end;
create trigger pricing_rates_no_delete before delete on pricing_rates
begin select raise(abort, 'an imported pricing catalog is never edited'); end;

alter table usage_totals add column cli_cost_micros integer;

create table pricing_checks (
  office_id text not null references offices (office_id),
  run_id text not null,
  est_cost_micros integer not null,
  cli_cost_micros integer not null,
  pricing_version text,
  raised_at integer not null,
  primary key (office_id, run_id)
) strict;
`,
};
