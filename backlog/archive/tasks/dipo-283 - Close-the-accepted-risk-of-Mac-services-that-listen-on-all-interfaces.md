---
id: DIPO-283
title: Close the accepted risk of a box reaching services on the Mac
status: To Do
assignee: []
created_date: '2026-10-21 13:54'
updated_date: '2026-10-22 18:16'
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
  - DIPO-288
  - DIPO-290
  - DIPO-292
  - DIPO-294
  - DIPO-295
  - DIPO-296
  - DIPO-298
references:
  - packages/engine/src/box/
  - docs/decisions/0021-worker-isolation.md
type: feature
ordinal: 272000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a box can no longer reach services on the Mac that listen on all interfaces or on the Mac's own local-network address, with the fix the maintainer chose in the 0021 amendment of 2026-10-21, so the accepted risk is closed.
Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-283/close-accepted-risk"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker inside the box cannot undo the fix
- [ ] #2 docs/decisions/0021-worker-isolation.md gets a dated amendment that closes the accepted risk
- [ ] #3 Line 2 of the DIPO-264 probe, and the direct line to the Mac's own local-network address in the real-box web-proxy test, fail for Mac services that listen on all interfaces or on that address, except the ports the office config allows (DIPO-282)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
To settle in refinement: how the fix holds while the worker runs with all permissions inside the box (DIPO-271), and whether it sits outside the box as 0021 section 3 asks; the amendment calls an in-box rule a second layer.

2026-10-22: combined into DIPO-281 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
