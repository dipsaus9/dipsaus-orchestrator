---
id: DIPO-111
title: >-
  Serve software commands after a failed migration and check the database after
  an unclean exit
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 09:47'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - docs/decisions/0007-state-database.md
  - packages/daemon/src/recovery.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/lifecycle.ts
  - packages/engine/src/db/
  - packages/engine/src/platform/sqlite.ts
  - packages/daemon/test
  - packages/engine/test/
  - packages/contract/src/
  - packages/daemon/src/server.ts
  - packages/daemon/src/restore.ts
priority: high
type: feature
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon follows 0007 sections 9 and 10: a database it cannot open or migrate leaves it up for the contract's software-level commands with a notice that says what to do, and an unclean exit is followed by PRAGMA quick_check at the next open.

Context: a failed migration, a network-filesystem refusal, an edited checksum or a too-new database exits the daemon with code 1 (packages/daemon/src/recovery.ts rethrows, packages/daemon/src/foreground.ts). With autostart (launchd SuccessfulExit=false, systemd Restart=on-failure) that is a silent restart loop, and each start writes another full VACUUM INTO pre-migration backup (packages/engine/src/db/migrations.ts). Staying up ends that loop, so the backup rule of 0007 section 9 does not change. checkIntegrity exists (packages/engine/src/platform/sqlite.ts) but the daemon never passes it, although the crash marker in foreground.ts already knows about an unclean exit. dipo restore and dipo daemon logs are offline maintenance outside the contract (0006 and 0005 amendments of 2026-10-12); restore takes dipo.pid, so the daemon must be stopped first. Found by the 2026-10-16 milestone review (TL;DR 4, section 2 on 0007).

Lifecycle state: the daemon must not let daemon.resumeScheduling or a retry make office commands look usable, so neither safe nor the retryable engine.recovering fits as is. If the fix needs a new DaemonState or a new error code, that is a dated note on 0006 decision 7 and 0005 that the maintainer approves before merge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A failed open or migration keeps the daemon running; it serves engine.hello, daemon.status, daemon.stop and daemon.setLogLevel, and refuses office commands and reads with a non-retryable error code; the daemon does not exit.
- [ ] #2 The notice and daemon.status say what to do for each failure kind: for a failed migration or a damaged file, run dipo daemon stop and then dipo restore with the newest backup (named when one exists); for a too-new database, upgrade dipo; for a network filesystem, move the state directory.
- [ ] #3 After an unclean exit, the next open runs quick_check; damage is reported the same way as a failed migration.
- [ ] #4 Tests cover a failing migration, a too-new database and a damaged file after an unclean exit, and show that dipo daemon stop followed by dipo restore works from the kept-up state.
<!-- AC:END -->
