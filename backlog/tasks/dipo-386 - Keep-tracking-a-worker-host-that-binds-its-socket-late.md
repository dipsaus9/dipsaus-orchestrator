---
id: DIPO-386
title: Keep tracking a worker host that binds its socket late
status: Refined
assignee: []
created_date: '2026-10-30 09:31'
updated_date: '2026-10-30 09:32'
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
- [ ] #1 dipo never signals a worker host whose PID it has not verified through the host's own handshake and verifyHostForSignal; a pending row whose socket did not answer is kept, not deleted, and asked again on each later recovery pass until the host's launch deadline has passed
- [ ] #2 A worker host that no daemon has claimed by its launch deadline exits on its own (a host-side timeout), so a host that never answers is not left running; the story then parks worker-failed and its pending row goes
- [ ] #3 Tests with real processes: a host that binds after the first ask is re-attached on the next pass; a host that never binds exits by itself at its deadline and the story parks; no process is signalled in either case
- [ ] #4 A process that is not that run's worker host (a reused PID, a command that only mentions the run id, a wrapper such as sh -c or env, a start time before the row, a zombie) is never signalled, shown by tests against verifyHostForSignal on the real path
<!-- AC:END -->
