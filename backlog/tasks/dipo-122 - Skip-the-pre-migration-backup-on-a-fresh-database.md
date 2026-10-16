---
id: DIPO-122
title: Skip the pre-migration backup on a fresh database
status: To Do
assignee: []
created_date: '2026-10-16 11:53'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db
  - packages/engine/test/db
priority: low
type: chore
ordinal: 112000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a first start writes no backups/pre-v<N>-<time>.db copy of an empty database.

Context: migrate() in packages/engine/src/db/migrations.ts writes the pre-migration backup whenever from < head, also when from is 0 on a fresh install. The copy is empty and takes one of the two pre-migration slots (packages/engine/src/backup/files.ts).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 migrate() writes no backup when the database is at version 0 and holds no user tables, and returns backup null
- [ ] #2 An existing database below head still gets its backup before the first step, and a failed step still names it
- [ ] #3 Tests cover the fresh database and the upgrade
<!-- AC:END -->
