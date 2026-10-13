---
id: DIPO-56
title: Reconcile the database with Backlog.md and git at daemon start
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 18:36'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-32
  - DIPO-38
  - DIPO-50
  - DIPO-68
  - DIPO-72
references:
  - packages/engine/src/reconcile/
  - packages/engine/test/reconcile/
  - packages/engine/src/recovery/
  - packages/engine/src/scan/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: high
type: feature
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: in the daemon's `recovering` state and on `office.rescan`, the engine compares its database with Backlog.md and git per the 0007 section 6 table, writes each mismatch as facts with an `engine.notice`, and changes nothing silently.

Context: required before cutover (maintainer decision D14, DIPO-15; 0003 amendment of 2026-10-12), so dipo never builds itself on a database that may disagree with Backlog.md and git after a restart. Reconcile is a recovery step registered with the daemon's `recovering` state (DIPO-68) and is also called by `office.rescan` (DIPO-72). References: 0007 section 6 (steps 1 to 6, table); 0001 "Data ownership"; 0005 section 2 (identity), open question 7; 0010 failure case "worktree or branch changed by hand"; 0006 decision 7 (recovering).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-56/reconcile-database-backlog-md-git-at"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) one test per row of the 0007 section 6 table with a fixture mismatch, asserting the facts and the notice."
    - kind: "automated"
      check: "(engine) a daemon start with a mismatch runs reconcile in `recovering` before scheduling turns on; `office.rescan` runs it again."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The `office.json` id is checked against the `offices` row; a mismatch refuses the office with a notice.
- [ ] #2 Lifecycle status is read from the story branch while claimed and from the base otherwise; a run active in the database whose status is no longer In Progress or In Review is stopped with a notice.
- [ ] #3 Status In Progress with no claim in the database is shown as an unknown run with a notice and never started.
- [ ] #4 An open park with no F16 block is closed with `resolved_how = reconcile`; an F16 block with no park row records a park with detail "recorded by hand".
- [ ] #5 Ready without a stored gate decision for the current content hash raises a notice; the pickup re-check decides.
- [ ] #6 A worktree or branch changed by hand under a running story parks it; `git worktree prune` runs only after confirmation.
- [ ] #7 Scheduling stays off until reconcile of every loaded office finishes.
- [ ] #8 Reconcile runs as a recovery step registered with the daemon's `recovering` state (DIPO-68) and when `office.rescan` (DIPO-72) runs.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S40 (DIPO-15). Moved before cutover in the M0 review (maintainer decision D14, DIPO-15). Before cutover: built by hand-run agents.

Follow-ups from DIPO-63 and DIPO-36 (2026-10-13): (1) release orphan claims at daemon start: a live claim whose run has no worker host (keep-awake stops counting it after CLAIM_START_WINDOW_MS, packages/engine/src/keepawake/activity.ts); (2) load every registered office at daemon start, so the merge slot poll and Done detection resume after a restart without waiting for an office command (a backlog PR open at restart otherwise waits).
<!-- SECTION:NOTES:END -->
