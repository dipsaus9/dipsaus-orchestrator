---
id: DIPO-360
title: Keep a story's status and park reason only in Backlog.md
status: Refined
assignee: []
created_date: '2026-10-27 16:52'
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
Outcome: a story's status and park reason have one source, Backlog.md, which dipo writes through the backlog lane; the parks table keeps run detail only, and on a mismatch Backlog.md wins and reconcile shows a notice.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-344 (its criterion 7). 0001, one source per fact. Read how reconcile works today before changing it; reconcile never picks between copies.

```dipo
branch: "DIPO-360/status-and-park-reason-in-backlog"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park writes its reason to the task file through the backlog lane and the parks table holds no reason"
    - kind: "automated"
      check: "(engine) reconcile with a status that differs from Backlog.md keeps Backlog.md and emits a notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A story's status and park reason live in Backlog.md and dipo writes them there through the backlog lane; the parks table keeps run detail only
- [ ] #2 On a mismatch between Backlog.md and dipo's state Backlog.md wins and reconcile shows a notice
- [ ] #3 Every reader of the removed copies reads Backlog.md instead, and a search finds no other copy of status or park reason
<!-- AC:END -->
