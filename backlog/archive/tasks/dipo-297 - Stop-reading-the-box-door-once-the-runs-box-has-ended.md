---
id: DIPO-297
title: Stop reading the box door once the run's box has ended
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
  - DIPO-295
references:
  - packages/engine/src/box/door.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/test/box/door.test.ts
priority: high
type: bug
ordinal: 286000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo stops reading a box's door when the run ends, so no 'the box door could not be read' line follows a normal end, while a door read that fails during the run is still logged and handled.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the line "the box door could not be read" (reason: the door read in the box exited 1) was logged one second after the run ended as verify-failing.

```dipo
branch: "DIPO-297/door-read-after-end"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No door read starts after the run has ended or its box is stopping
- [ ] #2 A door read that fails while the box runs is still logged and handled as before
- [ ] #3 A test with a fake box backend covers both
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-296 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
