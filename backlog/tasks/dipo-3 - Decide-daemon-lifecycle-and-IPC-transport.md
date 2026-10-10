---
id: DIPO-3
title: Decide daemon lifecycle and IPC transport
status: Done
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 12:28'
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
- [x] #1 ADR docs/decisions/0006-daemon-and-ipc.md records options, choice and why
- [x] #2 ADR specifies lifecycle states and crash recovery
- [x] #3 ADR specifies local security model for the transport
- [x] #4 Maintainer approved the decision
- [x] #5 ADR decides whether one engine process serves all offices or each office runs its own, and where the office list lives
- [x] #6 ADR defines how an office is opened, registered and switched to
- [x] #7 ADR defines how running workers survive a daemon restart and are re-attached (research idea 8)
- [x] #8 ADR defines how browser clients (a future web or 3D UI) connect: a local WebSocket or HTTP endpoint on 127.0.0.1 with a token, or a gateway package (research section 8)
- [x] #9 ADR defines daemon and engine logging: format, location, rotation and debug output
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (decision 0011): decide whether one engine process serves all offices or each office runs its own, and where the software-level office list lives.

Draft ADR 0006 by research agent. Reviews: block (entry points vs 0004); joint block (lock dir, browser token in URL, 0004 amendment framing); final block (upgrade surface, code in argv); verification block (snap browsers). All fixed. Contains 'Amends 0004 (needs maintainer approval)'. Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR 0006 accepted: one daemon per user for all offices; lock in a home-based state dir; lifecycle with recovery and safe mode; detached worker hosts that survive restarts; WebSocket over a Unix socket, optional loopback listener with single-use bootstrap code (off by default); autostart; keep-awake idle only like Claude Code; manual restart on upgrade; offices opened explicitly or by prompt; amendments to 0004 applied.
<!-- SECTION:FINAL_SUMMARY:END -->
