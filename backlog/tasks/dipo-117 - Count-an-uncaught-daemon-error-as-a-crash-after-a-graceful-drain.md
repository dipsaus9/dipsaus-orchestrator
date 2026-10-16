---
id: DIPO-117
title: Count an uncaught daemon error as a crash after a graceful drain
status: Done
assignee: []
created_date: '2026-10-16 11:06'
updated_date: '2026-10-16 12:08'
labels:
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-119
references:
  - packages/daemon/src/
  - packages/daemon/test
  - packages/engine/src/platform/background.ts
  - docs/decisions/0006-daemon-and-ipc.md
  - packages/engine/src/platform/safe-chain-proxy.ts
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
priority: high
type: feature
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an error no code catches (an unhandled rejection or an uncaught exception) is logged with its code when it has one, then the daemon drains gracefully and exits as a crash the crash-loop counter sees, in line with 0006 decision 7 and its 2026-10-12 DIPO-68 amendment ("A failed recovery step or an unclean exit counts toward the crash loop"). Maintainer decision of 2026-10-16 (option A).

Context: DIPO-110 found that under the binary's top-level await (packages/cli/src/main.ts) Bun 1.4.2 only reports an unhandled rejection and keeps running; the daemon goes on in an unknown state, the crash counter never counts it, and the next requested stop exits 1, which launchd (KeepAlive.SuccessfulExit=false) and systemd (Restart=on-failure) treat as a crash and restart (packages/daemon/test/integration/unhandled-rejection.ci.test.ts). DIPO-110's logUnhandledRejections in packages/daemon/src/foreground.ts logs and rethrows; no uncaughtException listener exists. Sync throws in timer callbacks are expected to behave the same; this story measures it. The drain (packages/daemon/src/drain.ts, 20 s cap) and the crash counter (packages/daemon/src/crash-counter.ts) exist. The DIPO-68 amendment says a requested drain exits 0 and is not a crash, so this drain needs its own non-clean outcome. DIPO-119 goes first, so a known database error in a background job does not become a crash-counted restart.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An unhandled rejection or uncaught exception in the daemon is logged once (with its errorCode when it has one), then starts a drain with its own reason; the drain is capped as usual and is followed by the normal socket close and database checkpoint.
- [x] #2 That drain is not clean: the crash marker stays (cleanExit is not called) and the process exits 1, so the next start counts a crash and three within 10 minutes start in safe. A second uncaught error during the drain does not start another drain. An uncaught error during a requested drain (SIGTERM or daemon.stop already in progress) also exits 1 and keeps the marker.
- [x] #3 A requested stop (daemon.stop, SIGTERM, bootout) with no uncaught error still exits 0 and is not counted.
- [x] #4 Tests cover a rejection and a sync throw from a timer in a real daemon process (CI test allowed; the timer test records the measured Bun 1.4.2 behaviour), the crash count after restart, and a clean stop; the proposed dated 0006 decision 7 note is in the PR for the maintainer's approval.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
An unhandledRejection or uncaughtException listener (onUncaughtErrors in packages/daemon/src/foreground.ts, replacing logUnhandledRejections) logs each error once with errorCode and never throws; StopRequests.crash() marks the exit a crash and requests a drain with reason "uncaught error" unless one is already requested. After the normal drain, socket close and checkpoint the daemon keeps the crash marker and exits 1. Measured Bun 1.4.2 (macOS arm64) under top-level await: a sync timer throw without a listener is reported and the process runs on, exit 1 at its end; with a returning uncaughtException listener it reaches only the listener; a listener that rethrows exits 7 at once. Tests: unit/uncaught-errors.test.ts, integration/uncaught-error.test.ts (in-process, daemon.stop), integration/uncaught-error.ci.test.ts (real process: rejection, timer throw, throw during SIGTERM drain, three crashes then safe and a clean stop). No live Claude sessions. Proposed 0006 decision 7 note is in the PR for maintainer approval.
<!-- SECTION:NOTES:END -->
