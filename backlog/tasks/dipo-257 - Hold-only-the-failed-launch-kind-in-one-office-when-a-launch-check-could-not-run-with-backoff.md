---
id: DIPO-257
title: >-
  Hold only the failed launch kind in one office when a launch check could not
  run, with backoff
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-22 05:33'
labels:
  - 'tier:M'
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-228
  - DIPO-248
  - DIPO-250
references:
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/run/places.test.ts
  - packages/engine/test/run/reviews.test.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/test/run/work-run.test.ts
priority: high
type: bug
ordinal: 136100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a launch check that proves the sandbox unsafe still holds the adapter in every office, but one that could not run holds only that launch kind (worker or reviewer) in that office and is retried with backoff; the hold notice names the probe and the fix; and a review start that keeps failing backs off without starving the other pending reviews.

Context: the maintainer's decision D5 of 2026-10-20 (answer A); dated 0008 note (launch checks) of 2026-10-20. On 2026-10-20 every review start's self-test failed with bun not found on the reviewer's PATH (DIPO-250): 49 failed starts across six stories, each a short live Haiku self-test session, retried about every 70 seconds with no cap, each holding claude-cli in every office. AdapterHolds (packages/engine/src/workers/hold.ts) keeps one hold per adapter for the whole daemon; gateLaunch (packages/engine/src/workers/hold.ts) sets it on any failed check that claudeLaunchChecks (packages/engine/src/workers/claude-cli/launch-checks.ts) returns and lifts it when the checks pass; the daemon builds the holds in packages/daemon/src/foreground.ts. The plan-limit schedule (packages/engine/src/run/plan-limit.ts), built in packages/engine/src/run/compose.ts, already re-checks on a timer with the engine clock. The self-test's verdicts already tell the two cases apart (packages/engine/src/workers/claude-cli/self-test.ts): `unsafe: true` when a probe write or read got through, `cannotRun` (unsafe false) when a tool was missing, a timeout, or the session ended early. work.run reads adapterHeld (packages/engine/src/run/work-run.ts). Places.drain (packages/engine/src/run/places.ts) offers each place only its first waiting start, oldest In Review first among pending reviews (pendingReviews, packages/engine/src/run/review-rounds.ts), and requeues it when the starter returns false; it runs at each worker exit decision, at office load and every minute while anything waits, and #disarm stops that tick when nothing waits. So a backed-off review at the head would starve every other pending review, and filtering it out of the pending list could stop the tick and leave an expired backoff never retried. Reviews.start (packages/engine/src/run/reviews.ts) writes a run.startFailed notice on a failed start; the story stays In Review and its review waits (0019 section 4, kept). The 0008 note of 2026-10-20 (DIPO-257) decides the two hold scopes, the backoff and the notice. The backoff steps, counting a refused approval call as could-not-run, and passing a backed-off review over in Places.drain are this story's design choices (design choice, not a maintainer decision; the maintainer may change it before a run).

```dipo
branch: "DIPO-257/scoped-launch-holds"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) launch-checks.test.ts: an unsafe self-test verdict holds the adapter in every office; a cannot-run verdict holds only that office's launch kind, and the other office and the other kind still launch"
    - kind: "automated"
      check: "(unit) a cannot-run hold is re-checked on the engine clock after each backoff step with a manual clock, with the held kind's launch context in that office; its notice names the probe and the fix; a passing check lifts it"
    - kind: "automated"
      check: "(unit) places.test.ts and reviews.test.ts: while the head pending review backs off, the next pending review starts; the backed-off review starts again after its wait with no other trigger, and the drain tick keeps running while it waits"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A launch check whose verdict is unsafe (a probe write or read got through) holds the adapter in every office, as today
- [ ] #2 A launch check that could not run (a missing tool, a timeout, a session that ended early; a refused approval call counts as one too (design choice, not a maintainer decision; the maintainer may change it before a run)) holds only that launch kind, worker or reviewer, in that office; the other kind and the other offices still launch, and its engine.notice names the probe and the fix; every launch-check failure other than a self-test could-not-run verdict (the tools, probe, settings, engine credential and Safe-Chain proxy checks, and a CLI start failure) keeps the hold in every office, so the scoped hold fails closed
- [ ] #3 A could-not-run hold is checked again with backoff, after 1, 2, 4 and 8 minutes and then every 30 minutes (design choice, not a maintainer decision; the maintainer may change it before a run), and lifts when the checks pass; the re-check is scheduled on the engine clock by the run composition in packages/engine/src/run/compose.ts, as the plan-limit schedule is, and runs the held kind's launch checks through gateLaunch with that office's launch context for that kind (the reviewer's for a reviewer hold, the worker's for a worker hold)
- [ ] #4 In Places.drain a review start that backs off is passed over and the next pending review in order starts in its place; the backed-off review starts again after its wait with no other trigger, and the drain's minute tick keeps running while any start waits for a backoff (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #5 Tests in packages/engine/test/workers/launch-checks.test.ts, packages/engine/test/run/places.test.ts packages/engine/test/run/reviews.test.ts and packages/engine/test/run/work-run.test.ts cover the unsafe and the could-not-run holds, the backoff with a manual clock, the notice text, the passed-over head and the retry after the wait
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: launch-check holds become checks of the box and its probe (0021 sections 1 and 16).
<!-- SECTION:NOTES:END -->
