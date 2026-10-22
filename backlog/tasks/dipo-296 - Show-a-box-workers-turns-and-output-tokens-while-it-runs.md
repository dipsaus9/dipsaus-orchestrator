---
id: DIPO-296
title: Show a box worker's turns and output tokens while it runs
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 08:33'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
  - DIPO-295
  - DIPO-297
references:
  - packages/engine/src/box/workers.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/test/box/workers.test.ts
priority: high
type: bug
ordinal: 285000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: while a worker runs in its box, dipo watch and the TUI show its turn count and output tokens as they grow, not 0 until the session ends.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the usage line said "0 turns" and "out 0" for six minutes while input and cache tokens grew, then jumped to 38 turns and 14,606 output tokens when the session ended. The cause is not known yet: the box path, or the stream parsing that the Mac worker shares.

```dipo
branch: "DIPO-296/box-live-usage"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR names the cause
- [ ] #2 A recording-based test shows the live usage of a box worker counting turns and output tokens during the session
- [ ] #3 If the Mac worker has the same gap, it is fixed there too and the test covers both
<!-- AC:END -->
