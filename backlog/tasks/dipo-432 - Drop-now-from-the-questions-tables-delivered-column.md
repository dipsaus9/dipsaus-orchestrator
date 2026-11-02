---
id: DIPO-432
title: Drop "now" from the questions table's delivered column
status: In Progress
assignee: []
created_date: '2026-11-02 14:04'
updated_date: '2026-11-02 14:47'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/run-state/questions.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/db/
  - packages/engine/test/run-state/
priority: low
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the database and the engine's types allow only what dipo writes: an answer is delivered `on-resume`, or not yet (null).

Proposed by the worker of DIPO-430 and accepted by the maintainer on 2026-11-02 (proposal 8d8846ff, DRAFT-11). Since DIPO-428 every question parks at once and since DIPO-430 the contract has no `delivered: "now"`; only `on-resume` is written (questions/permissions.ts). But migration 22 (packages/engine/src/db/migrations/0022-questions.ts about line 38) still checks `delivered in ('now', 'on-resume')`, and packages/engine/src/run-state/questions.ts still types `"now"` (`StoredQuestion.delivered`, `QuestionRow`, `closeQuestion`'s parameter, about lines 41-42, 62 and 192, with the doc comment at line 41).

Design: a new migration rebuilds `questions` in SQLite's table-rebuild order, as migrations 38, 41 and 58 do: create the new table with every column it has today (the 0022 columns plus `park_id` and `allow_used_at` from 0023; `wait_until` went in 73), its `(office_id, run_id)` foreign key to `runs`, and `check (delivered in ('on-resume'))` with null allowed; copy every row, mapping a stored `now` to `on-resume`; drop the old table, rename, and recreate its two indexes exactly: `questions_open` (0022) and the partial `questions_allow_once` (0023). No trigger remains on it (0057 dropped the last) and no table has a foreign key to it. The types drop `"now"`. The DIPO-426 start-up schema check must pass on a fresh and on a migrated database. 0007, 0020.

```dipo
branch: "DIPO-432/questions-delivered-on-resume"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a migration lets questions.delivered hold only on-resume or null, keeps every row, and the run-state types say the same"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the new migration `questions.delivered` accepts `on-resume` and null and refuses `now`, and a database with questions in every state keeps every row and column, a stored `now` read back as `on-resume`, shown by a migration test on fixture rows
- [ ] #2 After the rebuild the table has exactly the indexes `questions_open` and `questions_allow_once` with today's definitions and its foreign key to `runs`, shown by a test that reads them from `sqlite_schema` and `pragma foreign_key_list`; a fresh and a migrated database have the same schema
- [ ] #3 `"now"` is gone from `StoredQuestion`, `QuestionRow` and `closeQuestion` in run-state/questions.ts, shown by the diff and `tsc`
<!-- AC:END -->
