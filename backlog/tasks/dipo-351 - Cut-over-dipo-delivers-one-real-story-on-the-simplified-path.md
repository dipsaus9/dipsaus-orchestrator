---
id: DIPO-351
title: 'Cut over: dipo delivers one real story on the simplified path'
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-29 20:14'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-341
  - DIPO-342
  - DIPO-343
  - DIPO-344
  - DIPO-359
  - DIPO-360
  - DIPO-345
  - DIPO-361
  - DIPO-362
  - DIPO-364
  - DIPO-346
  - DIPO-347
  - DIPO-348
  - DIPO-309
  - DIPO-349
  - DIPO-350
  - DIPO-363
references:
  - docs/research/2026-10-24-simplification-audit.md
priority: high
type: task
ordinal: 331000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo built from main after Track 1 delivers one Ready story of this repository end to end, box, verify in the box, PR, reviewer box, CI, auto-merge and teardown, and the maintainer confirms the run, after which Track 2 is built by dipo.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. The cutover gate of 0003. The gap report of the run is filed as stories.

```dipo
branch: "DIPO-351/cutover-simplified-path"
unknowns: []
test_plan:
  entries:
    - kind: "manual"
      check: "Watch the cutover run and read its gap report"
      expect: "the story merged with no hand step, and every gap is a filed story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo is built from main after the last Track 1 story, pinned, and passes a smoke run on a scratch repository
- [x] #2 One Ready Track 2 story runs from dipo run to merged with no step done by hand
- [x] #3 Every gap the run shows is filed as a story before this one is Done
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Cutover done on 2026-10-29, confirmed by the maintainer. dipo was built from main after Track 1 and pinned at 6997b8d5 in a temp DIPO_HOME. It ran DIPO-366 with dipo run --box from Ready to merged (PR #442) with no step by hand: build and verify in the box, opus review approved, merge by dipo. The gaps the cutover showed are filed: DIPO-371 (fixed, #420), DIPO-372 (verify in the box, #430), DIPO-374 to DIPO-378 and DIPO-380. dipo now builds Track 2.
<!-- SECTION:FINAL_SUMMARY:END -->
