---
id: DIPO-398
title: Drop the zombie-aware test checks now that every box reaps
status: Ready
assignee: []
created_date: '2026-10-30 18:21'
updated_date: '2026-10-30 21:57'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-378
references:
  - packages/testkit/src/running.ts
  - packages/engine/test/platform/
priority: low
type: chore
ordinal: 376000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the test helpers no longer work around zombie processes, because every box dipo makes reaps its orphans (DIPO-378).

DIPO-378 (#473) starts every box with Apple container's --init. Its criterion 4 (remove the zombie-aware checks) waited, because boxes made by a dipo binary pinned before #473 still run this repository's verify without the init. Once the pinned binary includes #473 and no box made before it still runs, the checks go: packages/testkit/src/running.ts and the zombie cases in the platform process and deadline tests. One mechanism per goal (0001). 0008.

```dipo
branch: "DIPO-398/drop-zombie-checks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(testkit) process and deadline tests pass in a box made with --init, without the zombie-aware checks"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The box-reaping workarounds in packages/testkit/src/running.ts (the checks that treat a zombie left by a box without an init as gone) are removed; tests of the process probe's own zombie handling (process.test.ts withZombie, deadline.test.ts, the lock test fixtures) stay
- [ ] #2 bun run verify passes in a box made by a dipo binary that includes DIPO-378, shown by the story's own dipo run
- [ ] #3 No comment still explains a box zombie workaround in the test helpers
<!-- AC:END -->
