---
id: DIPO-402
title: Make the lock race test pass every time
status: Refined
assignee: []
created_date: '2026-10-30 22:58'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-387
references:
  - packages/engine/test/platform/lock-processes.test.ts
  - packages/engine/src/platform/lock.ts
priority: high
type: bug
ordinal: 380000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the lock race test passes every time, and if it ever failed because two processes held the lock, the lock is fixed.

Gap G17, 2026-10-30: packages/engine/test/platform/lock-processes.test.ts (DIPO-387, #478: two real processes race for the exclusive SQLite lock on dipo.lock) failed about 1 run in 4 on a clean origin/main on the maintainer's Mac, seen by the DIPO-390 builder. A builder is investigating whether the test's timing or the lock is wrong. 0005, 0001.

```dipo
branch: "DIPO-402/lock-test-flake"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) lock-processes.test.ts passes 60 runs in a row, 20 of them while bun run verify runs in parallel"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR names the cause of the failures from reproduced runs (pass and fail counts, the failing assertion and output)
- [ ] #2 If any failure showed two processes holding the lock at once, the lock is fixed with a test that fails before the fix; otherwise the test waits on a signal from each child instead of a sleep and still asserts that exactly one holds
- [ ] #3 The test passes 60 runs in a row on the Mac, 20 of them while bun run verify runs in parallel, recorded in the PR
<!-- AC:END -->
