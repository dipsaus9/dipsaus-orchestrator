---
id: DIPO-117
title: Count an uncaught daemon error as a crash after a graceful drain
status: To Do
assignee: []
created_date: '2026-10-16 11:06'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/daemon/src/
  - packages/daemon/test
  - packages/engine/src/platform/background.ts
  - docs/decisions/0006-daemon-and-ipc.md
priority: high
type: feature
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an error no code catches (an unhandled rejection or an uncaught exception) is logged with its code, then the daemon drains gracefully and exits as a crash the crash-loop counter sees, as 0006 decision 7 says ('an unknown failure is a crash'). Maintainer decision of 2026-10-16 (option A).

Context: DIPO-110 found that under the binary's top-level await (packages/cli/src/main.ts) Bun 1.4.2 only reports an unhandled rejection and keeps running; the daemon goes on in an unknown state, the crash counter never counts it, and the next requested stop exits 1, which launchd (KeepAlive.SuccessfulExit=false) and systemd (Restart=on-failure) treat as a crash and restart. DIPO-110's logUnhandledRejections in packages/daemon/src/foreground.ts logs and rethrows; sync throws in timer callbacks behave the same and have no listener. The drain (packages/daemon/src/drain.ts, 20 s cap) and the crash counter (packages/daemon/src/crash-counter.ts) exist. The 2026-10-12 DIPO-68 amendment says a requested drain exits 0 and is not a crash, so this drain needs its own non-clean outcome.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An unhandled rejection or uncaught exception in the daemon is logged once with its errorCode, then starts a drain with its own reason; the drain finishes writes, closes the socket and checkpoints the database within the drain cap.
- [ ] #2 That drain is not clean: the crash marker stays (cleanExit is not called) and the process exits 1, so the next start counts a crash and three within 10 minutes start in safe; a second uncaught error during the drain does not start another drain.
- [ ] #3 A requested stop (daemon.stop, SIGTERM, bootout) after no uncaught error still exits 0 and is not counted.
- [ ] #4 Tests cover a rejection and a sync throw from a timer in a real daemon process (CI test allowed), the crash count after restart, and a clean stop; the proposed dated 0006 decision 7 note is in the PR for the maintainer's approval.
<!-- AC:END -->
