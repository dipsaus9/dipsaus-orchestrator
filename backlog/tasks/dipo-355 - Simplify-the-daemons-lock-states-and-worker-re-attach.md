---
id: DIPO-355
title: 'Simplify the daemon''s lock, states and worker re-attach'
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-30 10:49'
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
- [x] #1 The lock is dipo.pid created with O_EXCL after a stale record is deleted, without the rename protocol or the minute check
- [x] #2 The safe state, crash markers and needsCheck are removed; a database that cannot open keeps the daemon in recovering with database.unavailable
- [x] #3 A host whose socket does not answer gets one verified SIGTERM and its story parks worker-failed; follow-only mode and the launch.json claim protocol are removed
- [x] #4 The auth frame, the loopback listener, contract major and minor versions, capability flags and daemon.autoRestartOnUpgrade are removed
- [x] #5 An adapter hold is kept per adapter, not only in the offices loaded when it is set or lifted, so a lifted hold does not return from an office that was not loaded and a hold set with no office loaded is kept (from the review of DIPO-359)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The daemon lock is dipo.pid created with O_EXCL; a stale record is deleted only if its bytes are unchanged since they were judged stale, the lock is checked again after the bind, a losing starter never touches the winner's socket, and a daemon that finds it lost the lock drains and exits at its minute check; only a starting daemon deletes dipo.pid, a client only reports a stale one. The safe state, crash markers, needsCheck and the quick_check are gone; a database that cannot open keeps the daemon in recovering with database.unavailable. A worker host that answers is re-attached; one that does not gets one SIGTERM after verifyHostForSignal and its story parks worker-failed; follow-only mode and the launch.json claim protocol are gone. The auth frame, contract versions, capability flags and daemon.autoRestartOnUpgrade are removed; the socket sits in a 0700 user-owned runtime directory. Adapter holds are kept per adapter for every registered office. ADR 0005's lock steps rewritten, approved by the maintainer. Follow-ups: DIPO-384 to DIPO-386, and a kernel lock story.
<!-- SECTION:FINAL_SUMMARY:END -->
