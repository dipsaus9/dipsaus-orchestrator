---
id: DIPO-277
title: >-
  Track each story's changed files and let the second of two overlapping stories
  catch up
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 22:21'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-273
references:
  - packages/engine/src/box/collisions.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/code.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/control-endings.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
priority: high
type: feature
ordinal: 266000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo computes every in-flight story's changed files from its delivered parts, tells the maintainer and both workers when two stories change the same file, and after the first merges brings the new main into the second story's branch and box, with a fix round when git cannot merge cleanly.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-277/changed-files-collisions"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The changed files come from the delivered parts against the start commit, not from the worker's list
- [x] #2 An overlap between in-flight stories is reported to the maintainer and both workers
- [x] #3 After the first merges, dipo merges the new main into the second story's branch and copies the result into its box; a conflict starts a fix round
- [x] #4 Detection uses git's merge check, with no model call; tests cover overlap, clean catch-up and conflict
<!-- AC:END -->
