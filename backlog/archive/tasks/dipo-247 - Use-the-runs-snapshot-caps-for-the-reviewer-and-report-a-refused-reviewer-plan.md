---
id: DIPO-247
title: >-
  Use the run's snapshot caps for the reviewer and report a refused reviewer
  plan
status: Refined
assignee: []
created_date: '2026-10-20 18:35'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-148
  - DIPO-292
references:
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/test/run/reviews.test.ts
priority: medium
type: bug
ordinal: 247000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a reviewer session runs with the caps of its run's start snapshot even after the office config changes, a refused reviewer launch plan raises an office notice as a refused worker plan does, and the reviewer's host-lost and minute-cap paths are tested.

Context: advisories of the DIPO-219 review (PR #267). reviewerSettings in packages/engine/src/run/review-launch.ts takes maxTurns and maxMinutes from runCaps of the run's snapshot and, when the snapshot has none (`reviewMaxTurns ?? config.review.maxTurns`), from the office config in force; 0020 section 5 has a run keep the caps of its start snapshot, so a config change after the start changes a review's caps. ReviewLauncher.start turns a PlanError from worker.prepare into `{ kind: "failed", reason }`, which only warns; the worker launch path (packages/engine/src/run/launch.ts) raises the run.planRefused engine.notice with planRefusedText naming the path and the character. packages/engine/test/run/reviews.test.ts has no test for a reviewer whose worker host is lost or for the reviewer minute cap.

```dipo
branch: "DIPO-247/reviewer-snapshot-caps"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run whose snapshot has review caps keeps them after the office config's review caps change; a run whose snapshot has none gets the caps written into its snapshot at the first review start and keeps them"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a PlanError at reviewer launch raises one run.planRefused notice with planRefusedText"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a reviewer whose host is lost and a reviewer past its minute cap each end the round as the code sets, with the review-failed step and the story's lifecycle checked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 reviewerSettings reads the reviewer's turn and minute caps only from the run's snapshot: a run whose snapshot has no review caps gets the office's current review caps written into its snapshot at its first review start, and later config changes do not change them
- [ ] #2 A PlanError at reviewer launch raises the run.planRefused engine.notice on the office with planRefusedText, as the worker launch does, besides returning the failed start
- [ ] #3 packages/engine/test/run/reviews.test.ts covers the snapshot caps after a config change, the planRefused notice, a reviewer whose worker host is lost and a reviewer past its minute cap
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: the reviewer has no box; its tools are read-only plus web (0021 section 10).

2026-10-22: combined into DIPO-148 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
