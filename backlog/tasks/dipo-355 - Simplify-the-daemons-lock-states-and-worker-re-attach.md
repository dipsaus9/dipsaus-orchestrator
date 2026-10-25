---
id: DIPO-355
title: 'Simplify the daemon''s lock, states and worker re-attach'
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/daemon/src/
  - packages/engine/src/runs/
  - packages/engine/src/run/reattach.ts
  - packages/client/src/
  - packages/contract/src/
priority: medium
type: chore
ordinal: 335000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon takes a plain PID lock, moves through starting, recovering, running and draining without safe mode or crash markers, re-attaches or parks each worker host, and has no browser listener, contract versioning or auto-restart on upgrade.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 7; 0005).

```dipo
branch: "DIPO-355/daemon-states-and-reattach"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(daemon) a stale dipo.pid is replaced and a live one is reported"
    - kind: "automated"
      check: "(engine) recovery parks a host that does not answer and re-attaches one that does"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The lock is dipo.pid created with O_EXCL after a stale record is deleted, without the rename protocol or the minute check
- [ ] #2 The safe state, crash markers and needsCheck are removed; a database that cannot open keeps the daemon in recovering with database.unavailable
- [ ] #3 A host whose socket does not answer gets one verified SIGTERM and its story parks worker-failed; follow-only mode and the launch.json claim protocol are removed
- [ ] #4 The auth frame, the loopback listener, contract major and minor versions, capability flags and daemon.autoRestartOnUpgrade are removed
<!-- AC:END -->
