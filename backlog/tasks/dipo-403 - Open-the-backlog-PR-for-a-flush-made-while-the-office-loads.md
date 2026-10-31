---
id: DIPO-403
title: Open the backlog PR for a flush made while the office loads
status: In Review
assignee: []
created_date: '2026-10-31 08:22'
updated_date: '2026-10-31 09:16'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-401
references:
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/pr/feature.ts
priority: medium
type: bug
ordinal: 381000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a planning-lane flush that runs during office load also opens or updates its backlog PR, so a pushed branch never waits for the next lane operation.

Gap G18, 2026-10-31: after the re-pin to 531b0fd5 the lane flushed 8 operations in the office-load step backlog.lane.replay and pushed its branch, but the after-flush step that opens the backlog PR failed with "Office ... has not loaded." (warn) and nothing retried; the PR (#498) opened only when the next accepted proposal flushed again. 0010, 0005.

```dipo
branch: "DIPO-403/lane-pr-after-load"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a replay flush at office load leads to an open backlog PR once the office has loaded, without another lane operation"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A flush during office load that pushes a branch gets its backlog PR opened or updated once the office has loaded, with no further lane operation
- [x] #2 The after-flush step that cannot run before the office has loaded is run again when the office-loaded event fires, not dropped; a failure after the office loaded is a warn line and a desk item
- [x] #3 A test with a real git remote reproduces the 2026-10-31 case: replay at load pushes, then the PR opens
<!-- AC:END -->
