---
id: DIPO-303
title: >-
  Take a changed office configuration on the base into force without a daemon
  restart
status: Done
assignee: []
created_date: '2026-10-22 14:25'
updated_date: '2026-10-22 19:15'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/office/manager.ts
  - packages/engine/test/office/load.test.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/stories/feature.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/src/scan/feature.ts
  - packages/engine/test/scan/profiles.test.ts
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
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a poll after a base move that changed .dipo/office.yaml puts the new configuration in force, for example storyPr.open from false to true"
    - kind: "automated"
      check: "(unit) dipo office rescan puts a changed .dipo/office.yaml in force"
    - kind: "automated"
      check: "(unit) a changed .dipo/office.yaml that is refused keeps the configuration in force and raises the existing notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The poll that re-indexes after a base move also reloads the office configuration when .dipo/office.yaml changed, and dipo office rescan does too
- [x] #2 A refused configuration keeps the one in force and raises the existing notice
- [x] #3 Tests cover a reload by the poll and by rescan
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: built by dipo's box run run_01M5JEZ0VHKQKFQ73JYF5E2BPV (PR #350); dipo's reviewer blocked it (the reload read the maintainer's checkout, not the base); a builder fixed that on the branch (d989cf17), and a second review passed. The base text wins once at the first poll after a daemon start; local deviations belong in office.local.yaml. Accepted advisories: the override at that first poll is only logged; the config.invalid text still names dipo office reload-config, which reads the checkout; the poll reads the base file on every fetch, also without a base move.
<!-- SECTION:NOTES:END -->
