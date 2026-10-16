---
id: DIPO-89
title: Refresh the pricing catalog and warn when estimates drift from the CLI cost
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
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
- [x] #1 The gap is measured per model from stored runs (estimate vs stored CLI cost) and its cause is written in the story notes (stale price, missing cache tier, or token accounting).
- [x] #2 A new catalog version with the corrected prices from the official pricing page ships as catalog-2.json, imported by the existing catalog import; catalog-1 stays unchanged.
- [x] #3 When a finished agent has both numbers and they differ by more than 10%, dipo logs one warn line per model and day naming the model, both numbers and the catalog version.
- [x] #4 Tests cover the import of the new catalog and the drift warning.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gap measurement (AC1), 2026-10-15. Source: the 23 committed recordings under packages/engine/test/recordings/claude-cli with a result modelUsage (the maintainer state database was not read). Per model, the final modelUsage tokens were priced at catalog 1 with the 5 minute and 1 hour cache-write split from the deduplicated assistant messages, and compared with the CLI costUSD.
- claude-haiku-5-5 (the only model in the recordings), 22 recordings: estimate equals the CLI cost to the micro-dollar (gap 0.0%), for example success-tools-subagent 3468 vs 3468 micro-USD and safety-main-git 3374 vs 3375.
- model-switch (derived recording: messages named claude-sonnet-4-5, totals keyed claude-haiku-5-5): the messages 1 hour split does not reach the totals row, all 1662 writes price as 5 minute writes, estimate 322 vs CLI 447 micro-USD, gap -27.9%.
- No recording covers Opus, Sonnet or Fable, so their gap could not be measured from stored runs.

Cause: token accounting of the cache tier, not a stale price and not a missing tier. Prices: every rate of catalog 1 equals the pricing page read on 2026-10-15 (https://platform.claude.com/docs/en/about-claude/pricing), cache tiers and the Haiku 5.5 long-prompt set included. Claude Code 2.1.296 writes almost everything to the 1 hour cache. applyTurnTotals kept a totals row 1 hour part only from messages with the exact same model id; when the turn totals key a model differently from its messages (the API answers claude-opus-5-5, the CLI may key modelUsage as claude-opus-5-5[1m] for a 1M-context session, which canonicalModel already strips), every write fell to the 5 minute rate. 5 minute writes are 1.25x input, 1 hour writes 2x, so the writes price 37.5% low; with writes the larger part of an agent run cost this gives the 25 to 28% low estimate seen in the M0 delivery sessions. That the delivery sessions keyed Opus with [1m] is inferred, not seen in a stored run.

Changes: ingest/usage.ts applyTurnTotals matches the 1 hour split by canonical model; catalog-2.json ships the rates read again on 2026-10-15 (unchanged; Mythos 5/5.1 and Haiku 3.5 stay out per the DIPO-62 maintainer decision); pricing/drift.ts logs one warn line per model and UTC day for a finished agent with both numbers more than 10% apart.

Review follow-up (PR #123): keys of one canonical model share the messages 1 hour writes in proportion to their cache writes (ingest/usage.ts); long-prompt bands match messages by canonical model when the row id has none (pricing/usage.ts); the drift warning keeps one line per canonical model and day and names the id as stored (pricing/drift.ts).

Known remaining gap: when messages name a different model than the turn totals (the model-switch case, for example a classifier switch from claude-haiku-5-5 to claude-sonnet-4-5), the canonical ids differ, so the 1 hour split still cannot reach the totals row and those writes price as 5 minute writes, about 28% low (model-switch recording: 322 vs 447 micro-USD). This is not fixed here; the drift warning surfaces it as one warn line for that model and day.
<!-- SECTION:NOTES:END -->
