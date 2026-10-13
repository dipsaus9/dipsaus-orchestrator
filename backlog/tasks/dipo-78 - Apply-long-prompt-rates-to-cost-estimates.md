---
id: DIPO-78
title: Apply long-prompt rates to cost estimates
status: To Do
assignee: []
created_date: '2026-10-13 11:41'
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
- [ ] #1 The price book loads every prompt_over rate set per model, not only prompt_over = 0
- [ ] #2 Each message is priced at the rates with the highest prompt_over below its prompt size (input + cache writes + cache reads); a model without long-prompt rates uses its base rates
- [ ] #3 Totals that sum messages (per run, per day, office usage) sum the per-message estimates, never re-price aggregated tokens
- [ ] #4 Tests cover a message just under, at and over the 100,000-token threshold for claude-haiku-5-5 and a model without long-prompt rates
<!-- AC:END -->
