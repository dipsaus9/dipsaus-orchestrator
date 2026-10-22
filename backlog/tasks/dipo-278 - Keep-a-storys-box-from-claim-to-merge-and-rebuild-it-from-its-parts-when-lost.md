---
id: DIPO-278
title: Keep a story's box from claim to merge and rebuild it from its parts when lost
status: Refined
assignee: []
created_date: '2026-10-21 13:45'
updated_date: '2026-10-22 08:32'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies:
  - DIPO-271
  - DIPO-275
  - DIPO-276
  - DIPO-279
  - DIPO-284
  - DIPO-289
  - DIPO-291
  - DIPO-292
  - DIPO-294
references:
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/run/
  - packages/engine/test/box/lifetime.test.ts
priority: high
type: feature
ordinal: 267000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story's box lives from claim to merge: running while the worker works, stopped while the story waits, rebuilt from the start commit and the delivered parts when lost, and deleted at merge, drop or discard.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-278/box-lifetime"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The box is stopped while the story waits for a review, an answer, a resume, CI or the maintainer, and started again for the next session
- [ ] #2 A missing box is rebuilt from the start commit plus the delivered parts; only undelivered work is lost, and the maintainer is told
- [ ] #3 Merge, drop and discard delete the box
- [ ] #4 Tests cover each transition
<!-- AC:END -->
