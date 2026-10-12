---
id: DIPO-21
title: Open the central state database with migrations
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
references:
  - packages/engine/src/platform/sqlite.ts
  - packages/engine/src/platform/sqlite-worker.ts
  - packages/engine/src/db/
  - packages/engine/test/db/
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0007-state-database.md
priority: high
type: feature
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine opens `<state>/dipo.db` through the platform module with the 0007 pragmas and modes, gives each office a handle that binds its `office_id`, and applies forward-only checksummed migrations with a backup before each run.

Context: one connection, used only by the daemon. Later stories add their tables as migrations. The module takes its logger as a parameter, because the daemon's log setup (DIPO-23) comes later (M0 review, DIPO-15). A transaction callback must be synchronous: an `await` inside it would let other offices' writes interleave on the one JS thread. References: 0007 sections 1 (connection, pragmas, network filesystem refusal, time budget), 2 (`<state>` layout), 3 (isolation by key, schema test), 9 (migrations), 10 (pre-migration `VACUUM INTO` in a Bun Worker, `quick_check` after unclean exit).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-21/open-central-state-database-migrations"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) open in a temp `<state>`, check pragmas and file modes."
    - kind: "automated"
      check: "(unit) migrations apply in order, rollback on a failing step, newer `user_version` refused, edited checksum refused."
    - kind: "automated"
      check: "(unit) schema key test catches a fixture table without `office_id`."
    - kind: "automated"
      check: "(CI) commit-pause measurement."
    - kind: "automated"
      check: "(unit) a transaction callback that returns a promise throws; `mount` and `mountinfo` fixtures with `nfs`, `smbfs`, `apfs` and `ext4` lines are classified correctly."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `platform/sqlite.ts` opens with `{ create: true, readwrite: true, strict: true }` and sets `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=67108864`; a new file gets `auto_vacuum=INCREMENTAL` before its first table.
- [ ] #2 The database and its directory are created with modes `0600` and `0700`; at open the module logs `sqlite_version()` through an injected logger and refuses a `<state>` on a network filesystem with an error naming the path, detected by parsing `mount` output on macOS and `/proc/self/mountinfo` on Linux.
- [ ] #3 Writes go through `immediate()` transactions; the transaction helper throws when its callback returns a thenable, and an office handle exposes no way to run a statement without its `office_id` bound.
- [ ] #4 Migration 1 creates `offices` and `schema_migrations` as `STRICT` tables; `PRAGMA user_version` mirrors the head.
- [ ] #5 Before applying pending migrations the runner writes `backups/pre-v<N>-<time>.db` with `VACUUM INTO` from a Bun Worker; a failing step rolls back and leaves `user_version` unchanged.
- [ ] #6 A database whose `user_version` is newer than the binary is refused with a message containing `upgrade dipo`; a recorded checksum that differs from the binary's step stops the load.
- [ ] #7 A schema test fails when an office-scoped table lacks `office_id` as the first primary key column.
- [ ] #8 A measurement test (CI only) records the commit time under `synchronous=FULL` in its output.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S06 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
