---
id: DIPO-296
title: 'Tidy up a box run''s live counter, door reads and box deletion log'
status: To Do
assignee: []
created_date: '2026-10-22 08:30'
updated_date: '2026-10-22 18:15'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-294
  - DIPO-295
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/box/door.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/test/box/door.test.ts
  - packages/engine/test/box/workers.test.ts
priority: high
type: bug
ordinal: 285000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: while a worker runs in its box, dipo watch and the TUI show its turn count and output tokens as they grow; dipo stops reading a box's door when the run ends, while a door read that fails during the run is still logged and handled; and the daemon logs 'ended box runs checked and deleted' once per deleted run, and deletes fill boxes a daemon crash left behind.

Context: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the usage line said "0 turns" and "out 0" for six minutes while input and cache tokens grew, then jumped to 38 turns and 14,606 output tokens when the session ended. The cause is not known yet: the box path, or the stream parsing that the Mac worker shares.

From DIPO-297: in the first box run (DIPO-275 on DIPO-248, run run_01M5H7RZ4HT6ZE49074MCH9EWF, 2026-10-22) the line "the box door could not be read" (reason: the door read in the box exited 1) was logged one second after the run ended as verify-failing.

From DIPO-307: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) the line was written twice in the same millisecond for the same run.

```dipo
branch: "DIPO-296/box-run-tidy-up"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR names the cause
- [ ] #2 A recording-based test shows the live usage of a box worker counting turns and output tokens during the session
- [ ] #3 If the Mac worker has the same gap, it is fixed there too and the test covers both
- [ ] #4 (from DIPO-297) No door read starts after the run has ended or its box is stopping
- [ ] #5 (from DIPO-297) A door read that fails while the box runs is still logged and handled as before
- [ ] #6 (from DIPO-297) A test with a fake box backend covers both
- [ ] #7 (from DIPO-307) The finish of ended box runs runs once per run, or logs once
- [ ] #8 (from DIPO-307) A test shows one line per deleted run
- [ ] #9 Fill boxes (dipo-fill-*) left by a daemon crash during a fill are deleted at daemon start
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined from DIPO-297, DIPO-307 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
