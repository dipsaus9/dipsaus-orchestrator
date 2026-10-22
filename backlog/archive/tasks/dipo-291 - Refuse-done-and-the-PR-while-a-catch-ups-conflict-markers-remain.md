---
id: DIPO-291
title: Refuse done and the PR while a catch-up's conflict markers remain
status: Refined
assignee: []
created_date: '2026-10-21 23:03'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
  - DIPO-299
references:
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/run/verify-in-box.test.ts
type: bug
ordinal: 280000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story whose catch-up committed conflict markers cannot reach verify, In Review or a PR until every conflicted path is resolved; deterministic code decides this, not the reviewer.

Context: DIPO-277 (PR #323) commits a conflicted catch-up with git's markers and starts a fix round; its review found nothing stops an unresolved marker from reaching review when it sits in a file that is not compiled or tested.

```dipo
branch: "DIPO-291/refuse-conflict-markers"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo records the conflicted paths of each catch-up
- [ ] #2 At done, before verify, a recorded path that still holds a line starting with '<<<<<<< ', '=======' or '>>>>>>> ' on the tip goes back to the worker as a fix-round item
- [ ] #3 The PR is not opened while such a line remains
- [ ] #4 Tests cover a resolved and an unresolved conflict
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-149 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
