---
id: DIPO-352
title: Cut the run vocabulary to five health states and three run endings
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-29 09:54'
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
- [x] #1 Health is lost, looping, stuck, quiet or busy; asking, limited and paused are removed, and the signals travel only as evidence on work.observed
- [x] #2 The phases are setup, build, review, test and merge
- [x] #3 The TUI, dipo watch and dipo desk show the new values
- [x] #4 dipo resume of a story that already runs answers changed: false (0005), the error story.notPausedOrParked is renamed now that pause is gone, and the always-zero onHold count of views/summary.ts is removed (from the review of DIPO-344)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Criterion 3 of the plan (a run ends done, parked or dropped) moved to DIPO-373 on 2026-10-29.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Health is lost, looping, stuck, quiet or busy, derived from stored rows; one no-output fact with run_signals.stuck_at gives quiet or stuck, and the watchdog facts reach clients only on work.observed. The verify phase is gone (migration 66 turns stored verify steps into build). The TUI, dipo watch and dipo resume show the new values, with the [follow] tag from WorkView.followOnly. Resume of a running story answers changed: false, story.notPausedOrParked is story.notParked, and onHold is removed. The run endings went to DIPO-373.
<!-- SECTION:FINAL_SUMMARY:END -->
