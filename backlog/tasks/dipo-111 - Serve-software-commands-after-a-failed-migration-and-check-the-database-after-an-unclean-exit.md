---
id: DIPO-111
title: >-
  Serve software commands after a failed migration and check the database after
  an unclean exit
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
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
priority: high
type: feature
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon follows 0007 sections 9 and 10: a database it cannot open or migrate leaves it up for software-level commands with a notice that names the backup, and an unclean exit is followed by PRAGMA quick_check at the next open.

Context: a failed migration, a network-filesystem refusal, an edited checksum or a too-new database exits the daemon with code 1 (packages/daemon/src/recovery.ts rethrows, packages/daemon/src/foreground.ts). With autostart (launchd SuccessfulExit=false, systemd Restart=on-failure) that is a silent restart loop, and each start writes another full VACUUM INTO pre-migration backup (packages/engine/src/db/migrations.ts). checkIntegrity exists (packages/engine/src/platform/sqlite.ts) but the daemon never passes it, although the crash marker in foreground.ts already knows about an unclean exit. Found by the 2026-10-16 milestone review (TL;DR 4, section 2 on 0007).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A failed open or migration keeps the daemon running in a state that serves software-level commands (status, logs, restore, stop) and refuses office commands with an error code and a notice naming the newest backup; the daemon does not exit.
- [ ] #2 A repeated start against the same failed migration does not write a second pre-migration backup for the same database file and schema version.
- [ ] #3 After an unclean exit, the next open runs quick_check; damage is reported the same way as a failed migration.
- [ ] #4 Tests cover a failing migration, a too-new database and a damaged file after an unclean exit.
<!-- AC:END -->
