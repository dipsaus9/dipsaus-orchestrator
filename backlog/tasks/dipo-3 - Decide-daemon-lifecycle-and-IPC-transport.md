---
id: DIPO-3
title: Decide daemon lifecycle and IPC transport
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-09 19:59'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR for how the engine runs detached and how clients connect. Cover: start, stop and status, single-instance lock, stale process handling, socket vs HTTP/WebSocket, local-only auth, keep-awake assertion while work is active, logging, and upgrade behavior when the daemon is running.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0006-daemon-and-ipc.md records options, choice and why
- [ ] #2 ADR specifies lifecycle states and crash recovery
- [ ] #3 ADR specifies local security model for the transport
- [ ] #4 Maintainer approved the decision
- [ ] #5 ADR decides whether one engine process serves all offices or each office runs its own, and where the office list lives
- [ ] #6 ADR defines how an office is opened, registered and switched to
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): decide whether one engine process serves all offices or each office runs its own, and where the software-level office list lives.
<!-- SECTION:NOTES:END -->
