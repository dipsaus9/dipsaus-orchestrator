---
id: DIPO-354
title: Cut the database housekeeping to one retention rule and one backup
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-30 07:07'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/db/
  - packages/engine/src/retention/
  - packages/engine/src/backup/
  - packages/engine/src/pricing/
  - packages/engine/src/changelog/
  - packages/daemon/src/
priority: medium
type: chore
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: cost is the cost the Claude CLI reports, one retention rule deletes run detail older than retention.days while keeping outcome rows and the daily rollup, the pre-migration backup is the only backup, and restore, purge, the epoch, the replay floor and the pricing catalogs are gone.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 7; 0007). Absorbs DIPO-330.

```dipo
branch: "DIPO-354/database-housekeeping-cut"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(db, manual clock) retention deletes an old run's detail and keeps its outcome row"
    - kind: "automated"
      check: "(engine) a cursor beyond the last row gets stream.resetRequired"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Usage rows store the cost the CLI reports, and the pricing catalogs, rate tables and pricing checks are removed
- [x] #2 One retention rule runs at office load and hourly, deletes run detail older than retention.days (default 30) and keeps outcome rows and usage_daily
- [x] #3 Daily backups, dipo restore and office purge are removed; the pre-migration backup stays
- [x] #4 Cursors carry no epoch, a cursor older than the oldest row or beyond the last gets stream.resetRequired, and the replay floor column is removed
- [x] #5 A worker host's end is set when its exit is ingested, so retention and keep-awake see ended hosts without a daemon restart
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Usage rows store the cost the Claude CLI reports (cost_micros), and the pricing catalogs, rate tables and checks are gone. One retention rule, retention.days (default 30, in office config version 14; shortDays and stateDays retired), runs at office load and hourly in batches of at most 5,000 rows and removes run detail only for runs that ended done or dropped, or parked with no live claim and no open park, before the cutoff; a run open at In Review is kept. Daily VACUUM INTO backups, dipo restore and office purge are removed; the pre-migration backup stays (two newest), and leftover daily copies go after a successful open. Cursors carry no epoch: the oldest stored row and the last seq decide stream.resetRequired, and the software stream's seqs start at the daemon start time. An ingested exit line ends the worker host row (DIPO-330). Migration 0068 drops the pricing tables and columns, change_log.tier, offices.epoch and replay_floor_seq and backfills open host rows. ADR 0005's list of the daemon's other forms no longer names restore (approved by the maintainer). Follow-up: DIPO-382 removes the quick_check after an unclean exit.
<!-- SECTION:FINAL_SUMMARY:END -->
