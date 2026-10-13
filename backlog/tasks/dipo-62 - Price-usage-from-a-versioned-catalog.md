---
id: DIPO-62
title: Price usage from a versioned catalog
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 08:38'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-45
references:
  - packages/engine/src/pricing/
  - packages/engine/src/db/migrations/
  - packages/engine/test/pricing/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
priority: medium
type: feature
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the binary ships versioned pricing catalogs that the daemon imports at open, each usage row carries an estimated cost with the catalog version, and a gap above 10% against the CLI's own cost raises a stale-catalog notice.

References: 0008 section 4 (catalog fields, estimated cost, cross-check); 0007 section 4 (`pricing_catalogs`, `pricing_rates`, micro-USD), "Usage" bullets; research idea 4.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-62/price-usage-from-versioned-catalog"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) cost of a recording's usage equals a hand-computed value; a changed catalog file fails the checksum."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `engine/src/pricing/catalog-<n>.json` lists per model id the input, output, 5-minute write, 1-hour write and read rates with effective date and source URL.
- [x] #2 The daemon imports any catalog version it lacks at open, verifies its checksum, and never edits an imported version.
- [x] #3 `usage_totals.est_cost_micros` and `pricing_version` are filled at each update.
- [x] #4 A difference above 10% between the estimate and the CLI's `costUSD` for a run raises one notice.
- [x] #5 Pricing reads `cache_create_5m` and `cache_create_1h` directly (their sum equals `cache_create`, DIPO-45). Spend the adapter reports beyond the per-message sums (aborted turns) is stored as 5-minute writes, so the estimate can be slightly low for 1-hour-heavy sessions; this is recorded as a known approximation in the pricing module's notes.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S46 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Implementation (DIPO-62):
- Catalog: packages/engine/src/pricing/catalog-1.json, rates in micro-USD per million tokens, read 2026-10-13 from https://platform.claude.com/docs/en/about-claude/pricing (0008 source 14). Effective date and source URL are catalog-level fields (0007 pricing_catalogs). Model ids derived from the page's model names (Claude Haiku 5.5 -> claude-haiku-5-5, matching recordings' canonicalModel). Claude Mythos 5/5.1 (limited availability) and Claude Haiku 3.5 (different id scheme, retired) are left out. Haiku 5.5 long-prompt rates (prompts over 100,000 tokens) are kept in the catalog and pricing_rates.prompt_over but not applied (estimates use base rates).
- Checksums: sha256 over the catalog JSON, released checksum recorded in pricing/catalog.ts; checked at import, and against the checksum a database already holds. Triggers refuse updates and deletes of imported catalogs.
- Migration 11 (0011-pricing.ts): pricing_catalogs, pricing_rates (software-wide), usage_totals.cli_cost_micros, pricing_checks (one stale-catalog notice per run). Renumbered from 8 after main took 8 to 10.
- Cross-check: notice code pricing.catalogStale (engine.notice, warn). A turn end that kept live numbers above the CLI's totals (aborted or crashed turn, recording pause-now) clears the agent's CLI cost, so no false notice is raised.
- Known approximations are in the header of packages/engine/src/pricing/index.ts (AC 5).

Scope additions:
- packages/engine/src/workers/claude-cli/{schema,interpret}.ts and workers/types.ts: read modelUsage costUSD and carry the CLI cost on the turn event (costUsd), run-cumulative like the token totals. Needed for AC 4; 0008 section 4 asks the engine to store costUSD.
- packages/engine/src/ingest/ingestor.ts: required pricing option (a PriceBook or explicit null); prices usage and runs the cross-check in the pass transaction.
- packages/engine/src/db/database.ts: imports catalogs after migrations and exposes StateDatabase.pricing.
- packages/engine/tsconfig.json: include src/**/*.json so tsc -b accepts the catalog import.

Scope additions (review of PR #69):
- packages/engine/src/db/schema.ts: registers migration 11 (pricing) in MIGRATIONS; every migration is listed there.
- packages/engine/src/index.ts: the pricing exports were removed again; nothing outside the engine uses them.
- IngestorOptions.pricing is now required (PriceBook or explicit null), so the wiring story cannot drop it silently; packages/engine/test/ingest/ingest.test.ts passes the imported catalog.
- recordCliCost returns the models whose cost matched no usage row; the ingestor logs a warning for each.
<!-- SECTION:NOTES:END -->
