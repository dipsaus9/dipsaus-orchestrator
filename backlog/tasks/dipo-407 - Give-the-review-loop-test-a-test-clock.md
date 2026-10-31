---
id: DIPO-407
title: Give the review loop test a test clock
status: Refined
assignee: []
created_date: '2026-10-31 08:39'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/test/engine/review-loop.ci.test.ts
  - packages/testkit/src/
priority: high
type: chore
ordinal: 385000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: review-loop.ci.test.ts runs in seconds instead of minutes.

Measured 2026-10-31 on verify-macos: packages/engine/test/engine/review-loop.ci.test.ts took 150 s, ten cases of 10 to 18 s each (a review next to a working session, a conflict hand-off, park and resume, a blocking security finding, red CI then green, and more), most of it real waiting. 0002.

```dipo
branch: "DIPO-407/review-loop-test-clock"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) review-loop.ci.test.ts runs every case against a test clock in under 20 s on macOS"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every case of review-loop.ci.test.ts keeps its assertions and runs against a test clock or event waits instead of real sleeps and polls
- [ ] #2 The file takes under 20 s on the Mac, measured before and after in the PR
- [ ] #3 No case is removed or skipped, and each still fails when its behaviour breaks (shown for at least two cases by a temporary break in the PR description)
<!-- AC:END -->
