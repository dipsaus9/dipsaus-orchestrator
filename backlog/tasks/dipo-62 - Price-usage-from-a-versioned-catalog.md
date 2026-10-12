---
id: DIPO-62
title: Price usage from a versioned catalog
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 14:42'
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
- [ ] #1 `engine/src/pricing/catalog-<n>.json` lists per model id the input, output, 5-minute write, 1-hour write and read rates with effective date and source URL.
- [ ] #2 The daemon imports any catalog version it lacks at open, verifies its checksum, and never edits an imported version.
- [ ] #3 `usage_totals.est_cost_micros` and `pricing_version` are filled at each update.
- [ ] #4 A difference above 10% between the estimate and the CLI's `costUSD` for a run raises one notice.
- [ ] #5 Pricing reads `cache_create_5m` and `cache_create_1h` directly (their sum equals `cache_create`, DIPO-45). Spend the adapter reports beyond the per-message sums (aborted turns) is stored as 5-minute writes, so the estimate can be slightly low for 1-hour-heavy sessions; this is recorded as a known approximation in the pricing module's notes.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S46 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
