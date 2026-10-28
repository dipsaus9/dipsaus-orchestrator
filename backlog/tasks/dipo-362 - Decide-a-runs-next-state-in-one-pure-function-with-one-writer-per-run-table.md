---
id: DIPO-362
title: Decide a run's next state in one pure function with one writer per run table
status: Refined
assignee: []
created_date: '2026-10-28 08:45'
updated_date: '2026-10-28 10:05'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-361
references:
  - packages/engine/src/run/
  - packages/engine/src/db/
priority: high
type: feature
ordinal: 342000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one pure function decides a run's next state from its state and an event, and each run table has exactly one writer.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-345 (its criterion 2), which absorbed DIPO-319 (read backlog/archive/tasks/ for its findings; its claims part was done by DIPO-348).

```dipo
branch: "DIPO-362/run-transitions-one-function"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the transition function covers every state and event pair of a run"
    - kind: "automated"
      check: "(lint or unit) no file other than its writer writes runs, parks, agents or worker_hosts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One pure function, with no I/O and no clock reads, decides the next state of a run from its state and an event, and every run transition goes through it
- [ ] #2 runs, parks, agents and worker_hosts each have one writer, and the three copies of the end-agent SQL are one
- [ ] #3 A resume whose finishing step throws after the lift reached the branch leaves its intent pending with a notice instead of failing it, so a rescan cannot close the park row and strand the story In Progress (park-resume.ts recover; from the review of DIPO-360)
<!-- AC:END -->
