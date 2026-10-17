---
id: DIPO-123
title: Close the gaps DIPO-119 left in run decisions and permission timeouts
status: Done
assignee: []
created_date: '2026-10-16 11:53'
updated_date: '2026-10-17 17:13'
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

```dipo
branch: "DIPO-123/retry-failed-act-and-question-close"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a turn problem whose act fails is retried at the next cap tick, or the run parks with a worker-failed reason"
    - kind: "automated"
      check: "(unit) a question whose timeout close fails re-arms its timer and the retry closes it without a second reply"
    - kind: "automated"
      check: "(unit) a findQuestion failure in the timeout is covered"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A turn problem whose act failed (act returns false; packages/engine/src/run/outcomes.ts ignores it today) is retried at the next cap tick, or parks the run with a worker-failed reason, with a test
- [x] #2 A question whose timeout close failed re-arms its own timer and on that retry only closes the question, without sending a second reply, with a test
- [x] #3 A test covers a findQuestion failure in the timeout
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivered by dipo (M1a run 1, run_01M55CQA2468N35QN7V2D5S9MY, Haiku low effort): 46 turns, 6 minutes, about $0.05, In Review on DIPO-123/retry-failed-act-and-question-close with verify run by dipo. The worker reported 10 test failures that happen only inside its sandbox (DIPO-176) and showed they also fail on the base commit.

Maintainer side: verify outside the sandbox passed (3130 tests). Review passed with advisories; two were fixed on top in DIPO-123/retry-failed-act-review: a failing unflagged act no longer drops a waiting turn-problem retry, and new outcomes tests drive real error, contextFull and startFailed turn problems so the retryAtTick flags are proven. The close and cap-tick retries stay unbounded (they stop when the run or question is decided, closed or unloaded).

Choice left open by the worker: a findQuestion failure in the timeout still leaves the question open until the next office load; criterion 3 asked only for a test.
<!-- SECTION:NOTES:END -->
