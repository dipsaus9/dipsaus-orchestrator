---
id: DIPO-401
title: Flush the planning lane again and say when it cannot
status: Refined
assignee: []
created_date: '2026-10-30 22:38'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/backlog/lane/
  - packages/engine/src/backlog/pr/
  - packages/engine/src/create/stories.ts
priority: high
type: bug
ordinal: 379000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the planning lane flushes its pending operations into a backlog PR again, an operation that cannot apply is closed with a notice instead of blocking the rest, and a lane that cannot flush says so in the log and on the desk.

Gap G16, found 2026-10-30: since 08:03 that day the lane journal of this repository's office holds 10 pending operations (8 accepted proposals that should become Backlog drafts, 2 discards of stories that are Done by now) and no backlog PR was opened; the last lane PR was #440 on 2026-10-29. No backlog PR is open, so the lane is not held. `dipo propose accept` journals an op and answers ok, yet nothing is pushed and nothing is logged even at debug level, so the maintainer only learns of it by reading the database. 0010, 0012, 0001.

```dipo
branch: "DIPO-401/lane-flushes-again"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) journaled propose operations flush into one backlog PR against a real git remote; an operation that cannot apply is closed with a notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR names the cause of the stall, reproduced with fixtures against a real git remote
- [ ] #2 Pending operations flush into one backlog PR again, and an operation that cannot apply (for example a discard of a story that is already Done) is closed with a notice instead of blocking the others
- [ ] #3 Every early return or failure of a flush writes an info or warn log line with the reason, and a desk item tells the maintainer when operations stay pending past a bounded time
- [ ] #4 Tests cover the cause, the fix, the closed operation and the stuck-lane desk item, against real git under DIPO_TMP
<!-- AC:END -->
