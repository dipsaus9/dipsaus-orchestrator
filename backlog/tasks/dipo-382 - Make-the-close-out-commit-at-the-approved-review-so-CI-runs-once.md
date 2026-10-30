---
id: DIPO-382
title: 'Make the close-out commit at the approved review, so CI runs once'
status: Refined
assignee: []
created_date: '2026-10-30 08:10'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/merge/close-out.ts
  - packages/engine/src/merge/gates.ts
  - packages/engine/src/merge/stories.ts
  - packages/engine/src/story-pr/
  - packages/engine/src/run/
priority: high
type: enhancement
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a dipo story waits for CI once. dipo makes the close-out commit as soon as the review approves the head, and the required checks run once, on the close-out head, before the merge.

Measured on PRs #447 and #449 (2026-10-29 and 2026-10-30): the worker pushes the In Review head, the review approves it within about 2 minutes, then dipo waits about 16 minutes for CI on that head, pushes the close-out commit (final summary and status Done), and CI runs about 16 minutes again on a commit that changes only the task file. About 30 of the 35 to 45 minutes from Ready to merged are CI, half of it repeated. ci.yml cancels an in-progress run on a new push to the same PR, so closing out right after the verdict costs nothing. 0002 already says dipo makes the close-out commit and asks GitHub to merge when green; this removes the wait for green before the close-out. Maintainer's choice of 2026-10-30. 0002, 0012, 0020.

```dipo
branch: "DIPO-382/close-out-at-the-verdict"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) an approved verdict leads to the close-out commit without waiting for checks, and a red check on the close-out head starts a fix round"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After an approved verdict on the current head, dipo commits the close-out (final summary and status Done) and enables auto-merge without waiting for the required checks of the reviewed head
- [ ] #2 The required checks are awaited once, on the close-out head; a red or failed check there starts a fix round as a red check does today, and the fix round's new head is reviewed again before a new close-out
- [ ] #3 The final summary is built from the facts known at close-out; any line that counted CI attempts says what it counts or is removed
- [ ] #4 A test with the engine's fakes shows the order verdict, close-out commit, auto-merge, one wait for checks, merge, and no wait for checks between the verdict and the close-out
<!-- AC:END -->
