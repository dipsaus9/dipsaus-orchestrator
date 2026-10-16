---
id: DIPO-119
title: Guard the remaining background jobs and timer writes
status: Done
assignee: []
created_date: '2026-10-16 11:06'
updated_date: '2026-10-16 11:37'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/backup/
  - packages/engine/src/run/control.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/platform/background.ts
  - packages/engine/test/
priority: medium
type: feature
ordinal: 109000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the backup scheduler's check and the sync database writes inside timer callbacks go through the DIPO-110 background helper or a guard, so a database error there is logged with its code instead of reaching the process.

Context: the DIPO-110 review found packages/engine/src/backup/scheduler.ts runs void this.check().finally(...) with no catch, and that sync writes before the guard remain: recordIntent in RunControl.act (packages/engine/src/run/control.ts) and #close in the PermissionAsks timeout timer (packages/engine/src/hooks/permissions.ts).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The backup scheduler's check runs through background() with the re-arm in settled; a test with a throwing dependency (database(), backupDue() or a file-system read) shows one logged failure and the timer re-armed.
- [x] #2 The sync writes in act() and the PermissionAsks timer are guarded and logged once with their errorCode. A failed recordIntent sends no ops and act returns false (0008: an op is stored as an intent before it is sent). When #close fails in the timeout, the deny reply is still sent and the failure is logged.
- [x] #3 Tests make the act() and timer writes fail through a SQLite trigger and show no unhandled rejection or uncaught exception, one logged failure, and the component still working.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Backup scheduler timer check runs through background() with the re-arm in settled. RunControl.act guards recordIntent: on failure it logs 'storing a run's decision failed' with errorCode, sends no ops, keeps the cap tick and returns false. PermissionAsks timeout guards findQuestion and #close: a failed close is logged once with errorCode and the deny is still sent; the question stays open until the next office load expires it. Tests: SQLite triggers on run_intents and questions, a throwing database() for the scheduler. bun run verify green; DIPO_TEST_CI=1 run/hooks/backup tests green. No live runs.
<!-- SECTION:NOTES:END -->
