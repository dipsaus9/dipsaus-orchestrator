---
id: DIPO-110
title: Keep the daemon up when a background job fails
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/log/
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/index.ts
  - packages/engine/test/
  - packages/daemon/test
priority: high
type: feature
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a database or I/O error inside a fire-and-forget engine job is logged and reported, never an unhandled rejection that exits the daemon and counts as a crash.

Context: an unhandled rejection exits Bun 1.4.2, and no package registers unhandledRejection. Two jobs write to the database outside their try: the permission reply notice (packages/engine/src/hooks/permissions.ts, office.immediate after the catch) and markIntentSent in run control (packages/engine/src/run/control.ts). Under autostart that is a restart the maintainer does not see. Found by the 2026-10-16 milestone review (TL;DR 4, suggestion 3).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One helper tracks every fire-and-forget engine job: it attaches the error handler before finally and logs through the engine logger; the two writes above sit inside the guard.
- [ ] #2 The daemon registers an unhandledRejection handler that logs the error with its code and keeps serving.
- [ ] #3 Tests make each of the two writes throw and show the daemon process keeps running and logs one error.
<!-- AC:END -->
