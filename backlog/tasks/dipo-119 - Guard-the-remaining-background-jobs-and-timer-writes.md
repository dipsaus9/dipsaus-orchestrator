---
id: DIPO-119
title: Guard the remaining background jobs and timer writes
status: To Do
assignee: []
created_date: '2026-10-16 11:06'
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
- [ ] #1 The backup scheduler's check runs through background() with the re-arm in settled.
- [ ] #2 The sync writes in act() and the PermissionAsks timer are guarded; a failure is logged once with its errorCode and the component keeps working.
- [ ] #3 Tests make each write fail through a SQLite trigger and show no unhandled rejection or uncaught exception and one logged failure.
<!-- AC:END -->
