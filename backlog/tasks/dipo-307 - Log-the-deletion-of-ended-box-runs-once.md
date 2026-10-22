---
id: DIPO-307
title: Log the deletion of ended box runs once
status: To Do
assignee: []
created_date: '2026-10-22 14:26'
updated_date: '2026-10-22 14:26'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-295
  - DIPO-296
  - DIPO-297
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/box/workers.ts
priority: medium
type: bug
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon logs 'ended box runs checked and deleted' once per deleted run, not twice.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) the line was written twice in the same millisecond for the same run.

```dipo
branch: "DIPO-307/box-delete-log-once"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The finish of ended box runs runs once per run, or logs once
- [ ] #2 A test shows one line per deleted run
<!-- AC:END -->
