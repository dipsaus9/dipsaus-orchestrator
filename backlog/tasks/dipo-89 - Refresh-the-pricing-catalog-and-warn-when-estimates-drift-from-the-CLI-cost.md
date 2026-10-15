---
id: DIPO-89
title: Refresh the pricing catalog and warn when estimates drift from the CLI cost
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-15 20:50'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/pricing/
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/ingest/usage.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/test/pricing/
  - packages/engine/test/ingest/
priority: medium
type: feature
ordinal: 79000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo cost estimates match the cost the Claude CLI reports within a few percent, and a later price change shows up as a warning instead of a silent gap.

Context: seen in the M0 delivery sessions: estimated cost was about 25% off the total_cost_usd of the Claude results. The shipped catalog is packages/engine/src/pricing/catalog-1.json (effectiveDate 2026-10-13); catalogs import once per version (packages/engine/src/db/database.ts:53-63). The adapter already passes the CLI cost per model as costUsd on turn events (packages/engine/src/workers/claude-cli/interpret.ts:856-863) and ingestion stores it (packages/engine/src/ingest/ingestor.ts:446). Prices must come from the official pricing page, not from memory.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The gap is measured per model from stored runs (estimate vs stored CLI cost) and its cause is written in the story notes (stale price, missing cache tier, or token accounting).
- [ ] #2 A new catalog version with the corrected prices from the official pricing page ships as catalog-2.json, imported by the existing catalog import; catalog-1 stays unchanged.
- [ ] #3 When a finished agent has both numbers and they differ by more than 10%, dipo logs one warn line per model and day naming the model, both numbers and the catalog version.
- [ ] #4 Tests cover the import of the new catalog and the drift warning.
<!-- AC:END -->
