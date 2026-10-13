---
id: DIPO-78
title: Apply long-prompt rates to cost estimates
status: Done
assignee:
  - '@claude'
created_date: '2026-10-13 11:41'
updated_date: '2026-10-13 12:00'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-62
references:
  - packages/engine/src/pricing/
  - packages/engine/test/pricing/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
priority: medium
type: feature
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a request whose prompt is over a model's long-prompt threshold is estimated at that model's long-prompt rates, so Haiku 5.5 cost estimates are not too low on long prompts.

Context: DIPO-62 imports the long-prompt rates (catalog longPrompt, pricing_rates.prompt_over) but estimates use the base rates only. The maintainer chose (2026-10-13) to apply them for cost awareness. The prompt size of a request is its input tokens plus cache-write and cache-read tokens, counted per message (usage_messages), not per run total.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The price book loads every prompt_over rate set per model, not only prompt_over = 0
- [x] #2 Each message is priced at the rates with the highest prompt_over below its prompt size (input + cache writes + cache reads); a model without long-prompt rates uses its base rates
- [x] #3 Totals that sum messages (per run, per day, office usage) sum the per-message estimates, never re-price aggregated tokens
- [x] #4 Tests cover a message just under, at and over the 100,000-token threshold for claude-haiku-5-5 and a model without long-prompt rates
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation (DIPO-78):
- PriceBook gains longPrompt: every prompt_over > 0 rate set per model, ascending (pricing/import.ts loadPriceBook loads all rows of the newest catalog). ratesFor(book, model, prompt) picks the set with the highest over below the prompt size; a prompt of exactly the threshold stays at base rates.
- priceAgentUsage (pricing/usage.ts) prices each usage_totals row as the sum of its usage_messages estimates: messages are summed per rate band in SQL by prompt size (input + cache_create_5m + cache_create_1h + cache_read), each band priced at its rates (estimate.ts messagesCostMicros). Exact BigInt arithmetic, rounded once, so a model without long-prompt rates prices exactly as before (it takes the totals path directly).
- Tokens the totals hold beyond the message sums (aborted turns' spend stored as 5m writes, turn-end output beyond per-message output, messages removed by retention while the agent runs) are priced at base rates. A field where messages hold more than the totals (live output before the first turn end) is scaled down to the totals. Recorded in the known-approximations header of pricing/index.ts, which no longer says long-prompt rates are not applied.
- usage_daily keeps summing usage_totals.est_cost_micros at finalize, so per-day and office sums are sums of per-message estimates. The 10% cross-check is unchanged and reads the same column.
- No schema change: usage_messages already holds per-message tokens and model.

Scope additions: none (all changed files are under packages/engine/src/pricing/ and packages/engine/test/pricing/).

Scope note correction: all code and test files are under packages/engine/src/pricing/ and packages/engine/test/pricing/; the story's own task file is CLI bookkeeping. Reviewer advisory for later: rowCost re-scans the agent's usage_messages per band on every update; switch to one GROUP BY query if profiling shows a cost.
<!-- SECTION:NOTES:END -->
