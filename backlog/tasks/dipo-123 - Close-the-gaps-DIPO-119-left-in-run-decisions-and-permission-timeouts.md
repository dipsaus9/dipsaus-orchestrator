---
id: DIPO-123
title: Close the gaps DIPO-119 left in run decisions and permission timeouts
status: Refined
assignee: []
created_date: '2026-10-16 11:53'
updated_date: '2026-10-16 14:17'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/run
  - packages/engine/test/hooks
  - packages/engine/src/run/outcomes.ts
priority: low
type: task
ordinal: 113000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a stored-intent failure and a failed question close do not leave work stuck until the next office load.

Context: advisory findings from the DIPO-119 review (PR #145). RunControl.act returns false when recordIntent fails, and nothing retries the turn problem it was acting on. PermissionAsks logs a failed timeout close and sends the deny, but the question stays open until the next office load expires it. The findQuestion failure branch in the timeout has no test.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A turn problem whose act failed (act returns false; packages/engine/src/run/outcomes.ts ignores it today) is retried at the next cap tick, or parks the run with a worker-failed reason, with a test
- [ ] #2 A question whose timeout close failed re-arms its own timer and on that retry only closes the question, without sending a second reply, with a test
- [ ] #3 A test covers a findQuestion failure in the timeout
<!-- AC:END -->
