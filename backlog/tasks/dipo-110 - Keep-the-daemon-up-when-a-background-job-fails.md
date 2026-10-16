---
id: DIPO-110
title: Keep the daemon up when a background job fails
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 10:17'
labels:
  - 'tier:M'
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
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/keepawake/keepawake.ts
  - packages/engine/src/retention/feature.ts
  - packages/engine/src/scan/feature.ts
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/platform/
priority: high
type: feature
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a database or I/O error inside a fire-and-forget engine job is logged and reported, never an unhandled rejection that exits the daemon and counts as a crash.

Context: an unhandled rejection exits Bun 1.4.2, and no package registers unhandledRejection. Jobs write to the database outside their try: the permission reply notice (packages/engine/src/hooks/permissions.ts, office.immediate after the catch) and markIntentSent in run control (packages/engine/src/run/control.ts, four sites). The same void job.finally(...) pattern, with no catch, is also in packages/engine/src/hooks/nudges.ts, packages/engine/src/run/plan-limit.ts, packages/engine/src/keepawake/keepawake.ts and the feature modules of retention, scan and stories. Under autostart a rejection is a restart the maintainer does not see. Found by the 2026-10-16 milestone review (TL;DR 4, suggestion 3).

The process-wide handler keeps today's policy of 0006 decision 7 (an unknown failure is a crash the crash-loop counter sees); it only makes sure the failure is logged with its code first. Known jobs stay up because the helper catches their errors. No decision changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One helper (in packages/engine/src/platform/ or next to the engine logger) tracks every fire-and-forget engine job in the files referenced: it attaches the error handler before finally and logs through the engine logger; the permission notice write and all four markIntentSent writes sit inside the guard.
- [x] #2 The daemon registers an unhandledRejection handler that logs the error with its code before the existing crash path runs.
- [x] #3 Tests make the permission notice write and a markIntentSent write throw and show the daemon process keeps running and logs one error.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
New helper packages/engine/src/platform/background.ts: background(job, { failed, fields, log, inflight, settled }) attaches the error handler first and logs a failure once (reason, errorCode) through the owner's engine logger (its warn dependency or logger.warn). Every fire-and-forget site in the referenced files uses it: permissions #reply (the reply notice), run control onHostLost, onEnded, act (markIntentSent), #begin (park, markIntentSent in #end), #afterTurn (verify feedback, markIntentSent in #sendFeedback); nudges, plan-limit wake, keep-awake poll, retention, stories poll and scan rescan. The fourth markIntentSent (#stopForReconcile) is awaited by reconcile, which catches. foreground.ts: two unguarded teardown promises now log, and logUnhandledRejections logs the error with errorCode, then rethrows so Bun handles it as before. Finding: under the binary's top-level await Bun 1.4.2 does not exit on an unhandled rejection; the daemon keeps running and exits 1 when it stops (unhandled-rejection.ci.test.ts). Tests: background.test.ts, permissions.test.ts and control.test.ts (SQLite triggers make the writes fail; no unhandled rejection, one logged failure), daemon unit and CI tests. No live sessions.
<!-- SECTION:NOTES:END -->
