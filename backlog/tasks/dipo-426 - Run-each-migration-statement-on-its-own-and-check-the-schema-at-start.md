---
id: DIPO-426
title: Run each migration statement on its own and check the schema at start
status: Refined
assignee: []
created_date: '2026-11-02 12:10'
updated_date: '2026-11-02 12:12'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db/migrations.ts
  - packages/engine/src/platform/sqlite.ts
  - packages/engine/src/db/database.ts
  - packages/engine/test/db/
priority: high
type: bug
ordinal: 404000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a migration statement that fails always stops the migration with an error, on any Bun version, and a database whose schema drifted from the migrations is found at daemon start instead of silently used.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. On Bun 1.4.2, in one `db.run` holding several statements, a NOT NULL, UNIQUE or foreign-key failure in any statement but the last is skipped without an error and the later statements run (reproduced by the review and by the orchestrating session). `SqliteConnection.exec` is `db.run(sql)` (packages/engine/src/platform/sqlite.ts about line 300), every SQL migration step runs through it (db/migrations.ts `applyStep`, about line 197), and the step is then recorded as applied, so a skipped statement never runs again. A table rebuild whose insert hits a constraint would drop rows and the old table without a word. Bun 1.4.4 (PR #544) throws, but nothing in dipo depends on that. The temp office's database (version 72) matched a fresh one on 2026-11-02; the maintainer's own database was not checked.

Design: `applyStep` splits a step's SQL into statements and runs each as its own prepared statement inside the step's transaction (a statement splitter that keeps triggers and quoted text whole), so any failure throws and rolls the step back. After migrating, the daemon compares the live schema (`sqlite_schema`: type, name, normalised sql) with the schema the steps build in a fresh in-memory database and refuses to start on a difference, naming the objects and the pre-migration backup. One migration path (0001). 0007.

```dipo
branch: "DIPO-426/migration-statements"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every statement of a migration step runs on its own so any failure throws, and the daemon refuses to start on a database whose schema differs from the one the steps build"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration step whose second statement violates a constraint throws, rolls the whole step back and leaves it unrecorded, on the Bun in .bun-version, shown by a test
- [ ] #2 A step holding a trigger body or a quoted semicolon still runs as written, shown by a test
- [ ] #3 The daemon refuses to open a database whose schema differs from the one the migrations build, naming each differing object and the backup file, shown by a test with a dropped index
- [ ] #4 Every migration from 1 to the latest still builds the same schema as today, shown by the existing fresh-versus-migrated schema test
<!-- AC:END -->
