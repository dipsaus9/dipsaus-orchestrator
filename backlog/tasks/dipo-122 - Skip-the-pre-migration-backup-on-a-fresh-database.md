---
id: DIPO-122
title: Skip the pre-migration backup on a fresh database
status: In Progress
assignee: []
created_date: '2026-10-16 11:53'
updated_date: '2026-10-22 13:56'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db
  - packages/engine/test/db
  - docs/decisions/0007-state-database.md
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
- [ ] #1 migrate() writes no backup when the database is at version 0 and holds no user tables, and returns backup null
- [ ] #2 An existing database below head still gets its backup before the first step, and a failed step still names it
- [ ] #3 Tests cover the fresh database and the upgrade
- [ ] #4 A dated 0007 note on the fresh-database exception is proposed in the PR for the maintainer's approval
<!-- AC:END -->
