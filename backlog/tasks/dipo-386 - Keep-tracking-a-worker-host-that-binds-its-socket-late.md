---
id: DIPO-386
title: Keep tracking a worker host that binds its socket late
status: Refined
assignee: []
created_date: '2026-10-30 09:31'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-355
references:
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/runs/worker-hosts.ts
priority: medium
type: chore
ordinal: 366000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker host that has read its launch.json but binds its socket more than 5 seconds later is still re-attached or stopped, never left running untracked.

Found by the review of PR #458 (DIPO-355), run/reattach.ts:304-318: after the PID ask times out the pending row goes and the story parks, but the host can still be starting and keeps running without a row. 0008, 0005.

```dipo
branch: "DIPO-386/late-socket-host"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a pending host that binds after the ask times out is found and stopped or re-attached"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A host that binds its socket after the PID ask timed out is never left running without a row: it is re-attached, or it is stopped with one verified SIGTERM and its story parks worker-failed
- [ ] #2 A test with a real process that binds late shows the outcome and that no process is left running
- [ ] #3 A process that is not that run's worker host is never signalled (the same checks as verifyHostForSignal)
<!-- AC:END -->
