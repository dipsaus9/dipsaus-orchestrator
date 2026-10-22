---
id: DIPO-122
title: Skip the pre-migration backup on a fresh database
status: Done
assignee: []
created_date: '2026-10-16 11:53'
updated_date: '2026-10-22 16:29'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db
  - packages/engine/test/db
  - docs/decisions/0007-state-database.md
  - packages/daemon/test/integration/database-unavailable.test.ts
  - packages/engine/test/backup/backup.test.ts
priority: low
type: chore
ordinal: 112000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a first start writes no backups/pre-v<N>-<time>.db copy of an empty database.

Context: migrate() in packages/engine/src/db/migrations.ts writes the pre-migration backup whenever from < head, also when from is 0 on a fresh install. The copy is empty and takes one of the two pre-migration slots (packages/engine/src/backup/files.ts). 0007 says a VACUUM INTO pre-v<N> runs first, before each migration, so this needs a dated 0007 note. It is the second box run after the verify redesign (DIPO-275, 2026-10-22), with story PRs on from the start.

```dipo
branch: "DIPO-122/skip-fresh-db-backup"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) migrate() on a fresh database at version 0 with no user tables writes no pre-migration backup and returns backup null"
    - kind: "automated"
      check: "(unit) migrate() on an existing database below head still writes its backup before the first step, and a failed step still names it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 migrate() writes no backup when the database is at version 0 and holds no user tables, and returns backup null
- [x] #2 An existing database below head still gets its backup before the first step, and a failed step still names it
- [x] #3 Tests cover the fresh database and the upgrade
- [x] #4 A dated 0007 note on the fresh-database exception is proposed in the PR for the maintainer's approval
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: Done by dipo's box run run_01M5HY626T0A2FGPR3SEK1ERKY, merged as #339 after the review advisories were fixed. The worker also adapted two tests outside the References (database-unavailable.test.ts, backup.test.ts); the scope finding was accepted, as References are a forecast for a box run (0021 decision 1).
<!-- SECTION:NOTES:END -->
