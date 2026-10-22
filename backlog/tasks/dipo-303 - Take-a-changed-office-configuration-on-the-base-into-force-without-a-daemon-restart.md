---
id: DIPO-303
title: >-
  Take a changed office configuration on the base into force without a daemon
  restart
status: To Do
assignee: []
created_date: '2026-10-22 14:25'
updated_date: '2026-10-22 14:26'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/office/manager.ts
  - packages/engine/test/office/load.test.ts
priority: medium
type: bug
ordinal: 292000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a change to .dipo/office.yaml that reaches the base branch is in force in the running daemon after the next poll or dipo office rescan.

Context: in the box retest of the verify redesign (DIPO-275: DIPO-300 run run_01M5HS75YC89DVXQAEMFFT01P5 and DIPO-122 run run_01M5HY626T0A2FGPR3SEK1ERKY, 2026-10-22) storyPr.open went from false to true on main (#336); dipo's base copy had the new file, but the story PR poll still read false after the poll and after dipo office rescan. Only a daemon restart (office load) took it into force.

```dipo
branch: "DIPO-303/reload-office-config"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The poll that re-indexes after a base move also reloads the office configuration when .dipo/office.yaml changed, and dipo office rescan does too
- [ ] #2 A refused configuration keeps the one in force and raises the existing notice
- [ ] #3 Tests cover a reload by the poll and by rescan
<!-- AC:END -->
