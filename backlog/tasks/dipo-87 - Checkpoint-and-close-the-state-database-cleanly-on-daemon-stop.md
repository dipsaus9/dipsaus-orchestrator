---
id: DIPO-87
title: Checkpoint and close the state database cleanly on daemon stop
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-15 19:24'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/daemon/src/foreground.ts
  - packages/engine/src/platform/sqlite.ts
  - packages/engine/src/db/database.ts
  - packages/engine/test/db/sqlite.test.ts
  - packages/daemon/test/integration/db-close.ci.test.ts
priority: medium
type: feature
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after dipo daemon stop the state directory holds dipo.db only; dipo.db-wal and dipo.db-shm are gone because the daemon checkpoints and closes the database on a clean stop.

Context: seen in the M0 delivery sessions: dipo.db-wal and dipo.db-shm stayed after every stop. The database runs in WAL mode (packages/engine/src/platform/sqlite.ts:273-279). The stop path closes it with held.database?.close() (packages/daemon/src/foreground.ts:955-958), which is db.close(true) (packages/engine/src/platform/sqlite.ts:356) with no wal_checkpoint first; close(true) throws when a statement is still open; possible causes are a missing checkpoint, an unfinalized statement, or a second connection still open. The drain itself (packages/daemon/src/foreground.ts:923-930) does not touch the database.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A clean stop runs pragma wal_checkpoint(TRUNCATE) after every office engine, retention and maintenance task has stopped, then closes the connection; after the process exits dipo.db-wal and dipo.db-shm do not exist.
- [ ] #2 A close that fails (open statement, busy checkpoint) is logged at warn with the reason and does not turn the clean exit into a crash.
- [ ] #3 A CI test starts and stops a daemon on a temp state dir and finds no -wal or -shm file left.
<!-- AC:END -->
