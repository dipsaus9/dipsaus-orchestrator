---
id: DIPO-65
title: Retain and back up state and report table sizes
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 08:33'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-21
  - DIPO-27
references:
  - packages/engine/src/retention/
  - packages/engine/src/backup/
  - packages/engine/src/features.ts
  - packages/cli/src/
  - packages/engine/test/retention/
  - packages/contract/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
priority: medium
type: feature
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each loaded office runs tiered retention in short batches, the daemon writes and checks a daily `VACUUM INTO` backup and runs maintenance in time slices, and `dipo stats` shows table sizes per office so the retention periods can be tuned.

Context: restore and purge were split into DIPO-76 in the M0 review (DIPO-15). `dipo stats` was placed here in the same review: 0007 names it for tuning retention, and it reads through a new contract read, `office.stats` (a minor addition), registered through the DIPO-22 seam; retention at office load is a load step through the DIPO-27 seam. References: 0007 sections 1 (50 ms slices), 7 (tiers D, R, T, S, P, replay floor, run directory deletion), 10 (backups, `quick_check`), "Size" (`dipo stats`); 0005 sections 7 (reads) and 8 (reset below the replay floor).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-65/retain-back-up-restore-purge-state"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) retention on the manual clock deletes R rows and moves the floor; a subscribe below it gets `stream.resetRequired`."
    - kind: "automated"
      check: "(integration) a daily backup is written from a Worker, passes `quick_check`, and the oldest copy beyond three is deleted."
    - kind: "automated"
      check: "(engine) `office.stats` returns a row count for every office-scoped table of the office."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Retention runs at load and hourly, at most 5,000 rows per transaction, using `retention.shortDays` and `retention.stateDays` from `office.local.yaml` or their defaults.
- [x] #2 Deleting R-tier change-log rows moves `replay_floor_seq`; a later subscribe below it gets `stream.resetRequired`.
- [x] #3 `events.ndjson` is deleted once a run has ended, been fully processed and summarised, or after tier R with a notice.
- [x] #4 A daily backup is written from a Bun Worker and checked with `PRAGMA quick_check`; 3 daily and 2 pre-migration copies are kept.
- [x] #5 Incremental vacuum, `wal_checkpoint(TRUNCATE)` and `optimize` run only when no office has active work, within the time budget.
- [x] #6 Read `office.stats { office }` (contract minor) returns the row count and approximate bytes of each office-scoped table, and `dipo stats [--office <id>]` prints them.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S49 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

M0 review (DIPO-15): restore and purge split into DIPO-76; `dipo stats` added here.

Scope additions (DIPO-65):
- packages/engine/src/db/migrations/0008-retention-indexes.ts and db/schema.ts: indexes on the time columns retention deletes by (change_log tier+at, requests, output_chunks, usage_messages), so each batch stays inside the 50 ms budget. Number 8 is also used by open PRs #65-#68; it is renumbered at merge.
- packages/engine/src/platform/clock.ts: yieldToEventLoop, the pause between slices.
- packages/engine/src/index.ts: exports backup/ and retention/.
- packages/daemon/src/foreground.ts: wires Retention (load step and hourly timer) and MaintenanceScheduler (daily backup and maintenance), and waits for both before the database closes.
- packages/cli/src/daemon-commands.ts (DaemonSession includes read), office-commands.ts (exports withOffice, parseOptions, Act), and read stubs in the session fakes of daemon-commands.test.ts, office-commands.test.ts and test/office-resolution/office-resolution.test.ts. Same change as open PR #66 (DIPO-71).
- packages/contract/schema/reads.schema.json regenerated for office.stats.
<!-- SECTION:NOTES:END -->
