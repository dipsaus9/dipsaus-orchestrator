---
id: DIPO-65
title: 'Retain, back up, restore and purge state'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
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
  - packages/engine/src/office/
  - packages/cli/src/
  - packages/engine/test/retention/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
priority: medium
type: feature
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each loaded office runs tiered retention in short batches, the daemon writes and checks a daily `VACUUM INTO` backup and runs maintenance in time slices, `dipo restore <file>` restores the whole file with new epochs, and `dipo office purge` deletes an office's rows and run directory.

References: 0007 sections 1 (50 ms slices), 3 (purge, missing repository notice), 7 (tiers D, R, T, S, P, replay floor, run directory deletion), 10 (backups, `quick_check`, restore); 0005 section 8 (reset after restore).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-65/retain-back-up-restore-purge-state"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) retention on the manual clock deletes R rows and moves the floor."
    - kind: "automated"
      check: "(integration) backup, corrupt the live file, restore; clients get `stream.resetRequired`."
    - kind: "automated"
      check: "(engine) purge removes every row with the office id."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Retention runs at load and hourly, at most 5,000 rows per transaction, using the periods from `office.local.yaml` or defaults.
- [ ] #2 Deleting R-tier change-log rows moves `replay_floor_seq`; a later subscribe below it gets `stream.resetRequired`.
- [ ] #3 `events.ndjson` is deleted once a run has ended, been fully processed and summarised, or after tier R with a notice.
- [ ] #4 A daily backup is written from a Bun Worker and checked with `PRAGMA quick_check`; 3 daily and 2 pre-migration copies are kept.
- [ ] #5 Incremental vacuum, `wal_checkpoint(TRUNCATE)` and `optimize` run only when no office has active work, within the time budget.
- [ ] #6 `dipo restore <file>` unloads offices, replaces the file, writes a new epoch per office and reconciles each.
- [ ] #7 `dipo office purge` asks for confirmation, deletes the office's rows in batches and its `<git-common-dir>/dipo/` directory.
- [ ] #8 An office whose path is missing is listed at start with the "open the new path, or purge" notice.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S49 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
