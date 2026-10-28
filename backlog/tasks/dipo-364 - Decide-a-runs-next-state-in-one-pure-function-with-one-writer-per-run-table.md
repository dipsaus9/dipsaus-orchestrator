---
id: DIPO-364
title: Decide a run's next state in one pure function with one writer per run table
status: Refined
assignee: []
created_date: '2026-10-28 12:26'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-362
references:
  - packages/engine/src/run/
  - packages/engine/src/db/
priority: high
type: feature
ordinal: 344000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one pure function decides a run's next state from its state and an event, each run table has exactly one writer, and the three copies of the end-agent SQL are one.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-362 (its criteria 1 and 2), whose part 1 moved the remaining messages onto sendFeedback. Absorbs DIPO-319's transition-function findings (backlog/archive/tasks/). Its builder counted the writers on 2026-10-28: runs from about 10 files, parks from 5, agents from about 10, worker_hosts from 6; the end-agent SQL is copied in outcome-exits.ts and reattach.ts.

```dipo
branch: "DIPO-364/run-state-one-writer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the transition function covers every state and event pair of a run"
    - kind: "automated"
      check: "(unit) a source scan finds no write to runs, parks, agents or worker_hosts outside their writer; retention deletes are exempt until DIPO-354"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One pure function, with no I/O and no clock reads, decides the next state of a run from its state and an event, and every run transition goes through it
- [ ] #2 runs, parks, agents and worker_hosts each have one writer, and the three copies of the end-agent SQL are one
<!-- AC:END -->
