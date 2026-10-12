---
id: DIPO-21
title: Open the central state database with migrations
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 11:51'
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
  - packages/engine/tsconfig.json
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
- [x] #1 `platform/sqlite.ts` opens with `{ create: true, readwrite: true, strict: true }` and sets `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=67108864`; a new file gets `auto_vacuum=INCREMENTAL` before its first table.
- [x] #2 The database and its directory are created with modes `0600` and `0700`; at open the module logs `sqlite_version()` through an injected logger and refuses a `<state>` on a network filesystem with an error naming the path, detected by parsing `mount` output on macOS and `/proc/self/mountinfo` on Linux.
- [x] #3 Writes go through `immediate()` transactions; the transaction helper throws when its callback returns a thenable, and an office handle exposes no way to run a statement without its `office_id` bound.
- [x] #4 Migration 1 creates `offices` and `schema_migrations` as `STRICT` tables; `PRAGMA user_version` mirrors the head.
- [x] #5 Before applying pending migrations the runner writes `backups/pre-v<N>-<time>.db` with `VACUUM INTO` from a Bun Worker; a failing step rolls back and leaves `user_version` unchanged.
- [x] #6 A database whose `user_version` is newer than the binary is refused with a message containing `upgrade dipo`; a recorded checksum that differs from the binary's step stops the load.
- [x] #7 A schema test fails when an office-scoped table lacks `office_id` as the first primary key column.
- [x] #8 A measurement test (CI only) records the commit time under `synchronous=FULL` in its output.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S06 (DIPO-15). Before cutover: built by hand-run agents.

Scope addition: packages/engine/tsconfig.json now includes `test` (rootDir `.`, as packages/contract already does with `scripts`). Without it the declared test directory packages/engine/test/db/ is run by bun test but never typechecked by `tsc -b`; an ad hoc check found real type errors there before the change.

Implementation (DIPO-21):
- packages/engine/src/platform/sqlite.ts: openSqlite creates <state> 0700 and pre-creates dipo.db 0600 (SQLite gives -wal and -shm the database file's mode; existing files are tightened), refuses a network filesystem by parsing /sbin/mount (macOS) or /proc/self/mountinfo (Linux) with an error naming the path, warns for a sync folder, sets auto_vacuum=INCREMENTAL on a file with no tables, then WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000, journal_size_limit=67108864, and logs sqlite_version() through the injected DbLogger. checkIntegrity runs quick_check (for the daemon after an unclean exit; the unclean-exit detection itself is DIPO-23). immediate()/deferred() throw AsyncTransactionError, rolling back, when the callback returns a thenable. vacuumInto runs VACUUM INTO on a read-only connection in a Bun Worker (sqlite-worker.ts), optional quick_check of the copy, copy mode 0600.
- packages/engine/src/db/: migrations.ts (forward-only, numbered 1..N, sha256 checksum of SQL or of a code step's declared source string, refuses user_version > head with 'upgrade dipo', stops on a checksum mismatch, writes backups/pre-v<head>-<yyyymmddThhmmss>.db before pending steps, each step in its own immediate transaction with foreign_key_check, schema_migrations insert and user_version), schema.ts (migration 1: STRICT offices and schema_migrations; SOFTWARE_TABLES), schema-check.ts (findOfficeKeyViolations), office.ts (OfficeHandle: every statement must use $office_id and may not bind it; no access to the connection), database.ts (openStateDatabase).
- Not in this story: offices.path uniqueness and insert defaults (DIPO-27), runs.kind/run_outcomes (D11/D12 belong to DIPO-48/DIPO-49), resolving <state> from the platform (DIPO-23).
- For DIPO-17: the compiled binary must include packages/engine/src/platform/sqlite-worker.ts as an extra entrypoint, because vacuumInto starts it with new Worker(new URL('./sqlite-worker.ts', import.meta.url)).
- Commit pause on macOS arm64 (local, sqlite 3.51.0, 200 commits): p50 0.04 ms, max 0.2 ms; the CI run prints the Linux numbers.
<!-- SECTION:NOTES:END -->
