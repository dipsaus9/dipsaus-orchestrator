---
id: DIPO-360
title: Keep a story's status and park reason only in Backlog.md
status: Done
assignee: []
created_date: '2026-10-27 16:52'
updated_date: '2026-10-28 10:05'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-344
references:
  - packages/engine/src/backlog/
  - packages/engine/src/stories/
  - packages/engine/src/run/
  - packages/engine/src/db/
priority: high
type: feature
ordinal: 340000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story's status and park reason have one source, Backlog.md, which dipo writes through the backlog lane; the parks table keeps run detail and the history of past parks, which no code reads as the current state, and on a mismatch Backlog.md wins and reconcile shows a notice.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-344 (its criterion 7). 0001, one source per fact. Read how reconcile works today before changing it; reconcile never picks between copies.

```dipo
branch: "DIPO-360/status-and-park-reason-in-backlog"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park writes its reason to the task file through the backlog lane, and every current-state reader takes the reason from Backlog.md, not from the parks table"
    - kind: "automated"
      check: "(engine) reconcile with a status that differs from Backlog.md keeps Backlog.md and emits a notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A story's status, park reason and park origin live in Backlog.md and dipo writes them there through the backlog lane; the parks table keeps run detail and the history of past parks (0007)
- [x] #2 On a mismatch between Backlog.md and dipo's state Backlog.md wins and reconcile shows a notice
- [x] #3 Every reader of the current status, park reason or park origin reads Backlog.md (or its mirror), the copies only those readers used are removed, and a search finds no current-state reader of parks.reason
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A story's status, park reason and park origin live in Backlog.md (the F16 park block), written through the backlog lanes; every current-state reader takes them from the mirror through one helper (run/park-state.ts). parks.reason stays as write-once history (final summary, run_outcomes); parks.from_state is dropped (migration 0060). On a mismatch reconcile closes the dipo row through resolvePark with a notice and never edits Backlog.md. Fail-closed: a maintainer park whose write fails answers story.parkNotWritten (a running story is stopped, its run ended and the unwritten park recorded), and heldByPark keeps the merge slot, reviewer, fix rounds and teardown closed while an unwritten park row is open; the desk shows PARK NOT WRITTEN or PARK HELD. Resumes check the captured park row, so a crash after the lift still finishes. Merged lane ops refresh the story, and an unreadable branch keeps its last read.
<!-- SECTION:FINAL_SUMMARY:END -->
