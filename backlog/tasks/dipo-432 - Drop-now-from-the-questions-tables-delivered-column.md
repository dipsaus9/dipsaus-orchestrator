---
id: DIPO-432
title: Drop "now" from the questions table's delivered column
status: Refined
assignee: []
created_date: '2026-11-02 14:04'
updated_date: '2026-11-02 14:30'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/run-state/questions.ts
  - packages/engine/test/db/
  - packages/engine/test/run-state/
priority: low
type: chore
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the database and the engine's types allow only what dipo writes: an answer is delivered `on-resume`, or not yet (null).

Proposed by the worker of DIPO-430 and accepted by the maintainer on 2026-11-02 (proposal 8d8846ff, DRAFT-11). Since DIPO-428 every question parks at once and since DIPO-430 the contract has no `delivered: "now"`, but migration 22 (packages/engine/src/db/migrations/0022-questions.ts about line 38) still checks `delivered in ('now', 'on-resume')` and packages/engine/src/run-state/questions.ts (about lines 42, 62 and 192) still types `"now"`.

Design: a new migration rebuilds `questions` with `check (delivered in ('on-resume'))` (null still allowed), in SQLite's table-rebuild order (create new, copy, drop, rename, then indexes and triggers as they are today), mapping any stored `now` to `on-resume`; the types drop `"now"`. The DIPO-426 start-up schema check must pass on a fresh and on a migrated database. 0007, 0020.

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
- [ ] #1 After the new migration `questions.delivered` accepts `on-resume` and null and refuses `now`, and a database with questions in every state keeps every row, a stored `now` read back as `on-resume`, shown by a migration test on fixture rows
- [ ] #2 The questions table's indexes and triggers are the same after the rebuild, and a fresh and a migrated database have the same schema, shown by the existing schema tests
- [ ] #3 `"now"` is gone from the run-state question types, shown by the diff and `tsc`
<!-- AC:END -->
