---
id: DIPO-352
title: Cut the run vocabulary to five health states and three run endings
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 07:24'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/contract/src/
  - packages/engine/src/views/
  - packages/engine/src/run/
  - packages/tui/src/
  - packages/cli/src/
priority: medium
type: feature
ordinal: 332000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a running session has one of five health states with the watchdog signals as their evidence, the phase verify is gone, and a run ends done, parked or dropped instead of four overlapping vocabularies.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Accepted proposals 2 and 3 (0009, 0020).

```dipo
branch: "DIPO-352/health-and-run-endings"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(contract, views) every run state maps to one health value and one ending"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Health is lost, looping, stuck, quiet or busy; asking, limited and paused are removed, and the signals travel only as evidence on work.observed
- [ ] #2 The phases are setup, build, review, test and merge
- [ ] #3 A run ends done, parked with its reason, or dropped; endKind strings, worker outcomes and park causes no longer describe an ending
- [ ] #4 The TUI, dipo watch and dipo desk show the new values
- [ ] #5 dipo resume of a story that already runs answers changed: false (0005), the error story.notPausedOrParked is renamed now that pause is gone, and the always-zero onHold count of views/summary.ts is removed (from the review of DIPO-344)
<!-- AC:END -->
