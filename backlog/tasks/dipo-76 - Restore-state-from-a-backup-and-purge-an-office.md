---
id: DIPO-76
title: Restore state from a backup and purge an office
status: In Progress
assignee: []
created_date: '2026-10-12 09:22'
updated_date: '2026-10-14 15:19'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-56
  - DIPO-65
references:
  - packages/engine/src/backup/
  - packages/engine/src/office/purge/
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/backup/
  - packages/engine/test/office/
  - packages/contract/
  - packages/engine/src/index.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/office/feature.ts
  - packages/engine/src/office/index.ts
  - packages/engine/src/platform/sqlite.ts
  - packages/daemon/test/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
priority: medium
type: feature
ordinal: 65500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo restore <file>` replaces the state database from a backup while the daemon is stopped, giving every office a new epoch so clients reset and the next start reconciles, and `office.purge` (`dipo office purge`) deletes an office's rows and its `<git-common-dir>/dipo/` directory after confirmation.

Context: split from DIPO-65 in the M0 review (DIPO-15); DIPO-65 keeps retention, backups, maintenance and `dipo stats`. `restore` is named offline maintenance outside the contract (0006 amendment of 2026-10-12) and runs daemon-side code, so it is a `runDaemon` form reached from `dipo restore`. `office.purge` is a contract command marked `confirm: true` and `irreversible: true` (0005 amendment of 2026-10-12), added through the registration seam of DIPO-22; it is software-level for idempotency, with its record in memory, since it deletes the office's request table (0005 amendment of 2026-10-12, section 9). Purge also removes `mcp.json` (0008 amendment). References: 0007 sections 3 (forget and purge, missing repositories), 10 (backups, `quick_check`, restore); 0005 section 8 (reset after restore); 0006 decision 6 (PID lock).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-76/restore-state-from-backup-purge-office"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) back up, corrupt the live file, restore; the `-wal` and `-shm` files are gone before the copy, and a reconnecting client gets `stream.resetRequired`."
    - kind: "automated"
      check: "(integration) `dipo restore` with a live daemon refuses and names `dipo daemon stop`."
    - kind: "automated"
      check: "(engine) purge removes every row with the office id and the office's `<git-common-dir>/dipo/` directory; purge with active work fails `office.busy`; a retried purge with the same `requestId` returns the stored reply."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `dipo restore <file>` runs through a `runDaemon` form and refuses while a live daemon holds `dipo.pid`, naming `dipo daemon stop`.
- [x] #2 Restore checks the backup with `PRAGMA quick_check`, closes its own connection, deletes the live `dipo.db-wal` and `dipo.db-shm`, then replaces `dipo.db` by copy and rename.
- [x] #3 Restore writes a new random epoch for every office, so a reconnecting client gets `stream.resetRequired`, and the next daemon start reconciles each office (DIPO-56).
- [x] #4 `office.purge { office }` is listed in `commands.describe` with `confirm: true` and `irreversible: true`, fails with `office.busy` while work is active, deletes the office's rows in batches within the time budget, and deletes its `<git-common-dir>/dipo/` directory including `mcp.json`.
- [x] #5 `office.purge` is handled as a software-level command: its idempotency record is kept in the daemon's in-memory request table, because purge deletes the office's own `requests` rows; a repeat with the same `requestId` returns the stored reply.
- [x] #6 `dipo office purge` asks for confirmation and says that the deletion cannot be undone.
- [x] #7 An office whose path is missing is listed at daemon start with the notice "path missing; `dipo office open` the new path, or `dipo office purge`".
- [x] #8 The contract definition of `office.purge` (DIPO-19, provisional) gets its final result shape and `since` in place of `provisional: true`, set to the next unreleased contract minor (`CONTRACT_VERSION.minor` is bumped only when no unreleased bump exists yet), the schema files are regenerated with `bun run contract:schema`, so AC #4's `commands.describe` entry with `confirm` and `irreversible` appears.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-65 in the M0 review (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

DIPO-27 review: DIPO-27 only refuses an office with a missing path when it loads (office.pathMissing); the daemon-start notice of AC #7 is still owed here.

DIPO-76 implementation:
- Restore: `dipo restore <file>` routes to the `restore` form of `runDaemon` (packages/daemon/src/restore.ts) with the file made absolute. The form takes `dipo.pid` through `acquireLock` like a starting daemon; a live daemon is refused naming `dipo daemon stop` (an unresponsive one `dipo daemon stop --force`). Engine `restoreBackup` (packages/engine/src/backup/restore.ts) copies the backup to `<state>/dipo.db.restore` (the backup file is never opened), opens the copy through the new platform `openSqliteFile` (rollback journal, so no sidecars), runs `PRAGMA quick_check`, checks it has `offices` and `schema_migrations` and no schema newer than the binary, writes a new random epoch into every `offices` row, closes, deletes the live `dipo.db-wal` and `dipo.db-shm`, renames the copy over `dipo.db` and fsyncs the directory. Any refusal leaves `dipo.db` unchanged. The next start migrates if needed and reconciles every office (DIPO-56 recovery step).
- Purge: `office.purge` ships in contract minor 1 (no bump; the minor is unreleased) with result `{ office, path, rows, directory? }`, `confirm: true`, `irreversible: true`; schema regenerated. Registered as a software command in `officeFeature`, so its idempotency record is in the executor's in-memory request table. `OfficeManager.purge`: `office.busy` from the registered active-work checks; the office leaves the list first (`forgotten_at`, `office.forgotten` event, instance dropped); `<git-common-dir>/dipo/` is removed only when its marker names this office; then `purgeOfficeRows` (packages/engine/src/office/purge/) deletes every table with an `office_id` column, found from the schema, children first by foreign keys, in Slicer batches of at most 5,000 rows within the 50 ms budget, and a last transaction removes leftovers and the `offices` row. A purge that stops halfway leaves a forgotten office a second purge finishes.
- `dipo office purge [--office <id>] [--yes]` asks at a terminal and says it cannot be undone; a script needs `--yes`. Resolved from the current directory, it checks the `engine.hello` office list first and refuses a copy whose marker names an office registered elsewhere, or an office not in the list, pointing to `--office <id>`.
- AC #7: the DIPO-56 recovery step loads every registered office at start, and the load refuses a missing path with the notice text on the software stream and in daemon.log; a CI test proves it at a real start.
- Finding outside scope: the logger redacts every field named `code`, so daemon.log shows `"code":"[redacted]"` for engine error codes.

Update after the 0005 amendment of 2026-10-14: `office.purge` takes an optional `from` (contract minor 1, schema regenerated), checked by the executor's shared `from` check, so a mismatch answers `office.unknown` with `details.reason: "path"`. `dipo office purge` sends the main worktree of the repository around the current directory as `from`, also with `--office`, and none outside a repository; this replaces the earlier `engine.hello` office-list check in the CLI.
<!-- SECTION:NOTES:END -->
