---
id: DIPO-283
title: Close the accepted risk of Mac services that listen on all interfaces
status: To Do
assignee: []
created_date: '2026-10-21 13:54'
updated_date: '2026-10-21 13:54'
labels:
  - box
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-271
  - DIPO-275
  - DIPO-277
  - DIPO-278
  - DIPO-282
references:
  - packages/engine/src/box/
  - docs/decisions/0021-worker-isolation.md
type: feature
ordinal: 272000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box can no longer reach services on the Mac that listen on all interfaces, with the fix the maintainer chose in the 0021 amendment of 2026-10-21, so the accepted risk is closed.
Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-283/close-accepted-risk"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Line 2 of the DIPO-264 probe fails for services that listen on all interfaces
- [ ] #2 The worker inside the box cannot undo the fix
- [ ] #3 docs/decisions/0021-worker-isolation.md gets a dated amendment that closes the accepted risk
<!-- AC:END -->
