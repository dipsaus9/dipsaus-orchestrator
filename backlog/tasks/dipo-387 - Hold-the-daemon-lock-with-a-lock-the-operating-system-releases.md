---
id: DIPO-387
title: Hold the daemon lock with a lock the operating system releases
status: Done
assignee: []
created_date: '2026-10-30 11:14'
updated_date: '2026-10-30 19:25'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-355
references:
  - packages/engine/src/platform/lock.ts
  - packages/daemon/src/foreground.ts
  - packages/client/src/node/lifecycle/
  - docs/decisions/0005-command-and-event-model.md
priority: medium
type: enhancement
ordinal: 367000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon's single-instance lock is a lock the operating system drops when the process dies, so no starter ever judges a record stale and two daemons can never both hold it.

After DIPO-355 (#458) the lock is dipo.pid created with O_EXCL; a starter deletes a stale record only if its bytes are unchanged, the lock is checked again after the bind and every minute. The review of #458 showed a remaining window of about 10 to 50 microseconds between the re-read and the unlink in which two starters can both win when one is paused at the wrong moment; the later checks catch nearly all, not provably all. The maintainer chose on 2026-10-30 to replace it: an exclusive SQLite lock (a `BEGIN EXCLUSIVE` transaction held open, or `locking_mode=EXCLUSIVE`) on a lock file next to dipo.pid, which needs no FFI. 0005 says "no FFI and no flock" for the lock today, so its lock section is rewritten. dipo.pid stays as the record clients read (PID, start time, runtime directory), no longer as the lock. 0005, 0006, 0001.

```dipo
branch: "DIPO-387/os-held-lock"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) two starters at once: exactly one holds the lock, with no stale judgement"
    - kind: "automated"
      check: "(daemon) a killed daemon's lock is free at once for the next starter"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The daemon holds an exclusive SQLite lock on a lock file in the state folder for its whole life; a second starter that cannot take it exits with the existing "already running" message and touches neither dipo.pid nor the socket
- [x] #2 No code judges a lock record stale or deletes dipo.pid to take the lock: the delete-if-unchanged step, the minute lock check and the post-bind check go, and dipo.pid is written only by the lock holder
- [x] #3 What the old lock caught, each with a test: a second starter while a daemon runs, a starter after a daemon was killed with SIGKILL (the lock is free at once), and a client reading dipo.pid for the PID and runtime directory
- [x] #4 Bypass forms are tested: a deleted or replaced dipo.pid while a daemon runs does not let a second daemon start; a lock file on a path that is a symlink is refused; two starters at the same moment, repeated, leave exactly one running
- [x] #5 Fail-closed against the real path: when the lock file cannot be created or locked (permissions, read-only folder), the daemon does not start
- [x] #6 0005's lock section is rewritten to the new lock with one Replaced line, approved by the maintainer
- [x] #7 The two-starters tests run each starter as its own process (fcntl locks are per process), and nothing else in the daemon opens the lock file, shown by a test or a lint check
- [x] #8 The "unresponsive" outcome is kept: a lock held by a live daemon whose socket does not answer the handshake is reported as unresponsive with the stop --force hint, never taken over
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The daemon holds an exclusive SQLite lock on <state>/dipo.lock (BEGIN EXCLUSIVE plus one uncommitted write, on its own connection kept from garbage collection) for its whole life; the operating system drops it on exit, also on SIGKILL, so no code judges a lock stale. A starter refuses a network state folder and a symlinked lock file and never runs without the lock; after taking it, it still refuses when dipo.pid names another live dipo daemon (a removed or replaced dipo.lock, or a daemon older than this lock); when busy it handshakes or reports unresponsive with the stop --force hint and never takes over. dipo.pid is only the record clients read, written by the lock holder. Removed: the delete-if-unchanged step, the O_EXCL create, holds(), the post-bind and minute lock checks, lock-lost.test.ts and the socket keep-file stop. Real-process tests cover the old cases, the bypass forms (two starters and two daemons at once, repeated; dipo.pid deleted or replaced; dipo.lock deleted or replaced) and the fail-closed cases. ADR 0005's lock section rewritten with one Replaced line, approved by the maintainer.
<!-- SECTION:FINAL_SUMMARY:END -->
