---
id: DIPO-56
title: Reconcile the database with Backlog.md and git at daemon start
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 13:08'
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
- [x] #1 The `office.json` id is checked against the `offices` row; a mismatch refuses the office with a notice.
- [x] #2 Lifecycle status is read from the story branch while claimed and from the base otherwise; a run active in the database whose status is no longer In Progress or In Review is stopped with a notice.
- [x] #3 Status In Progress with no claim in the database is shown as an unknown run with a notice and never started.
- [x] #4 An open park with no F16 block is closed with `resolved_how = reconcile`; an F16 block with no park row records a park with detail "recorded by hand".
- [x] #5 Ready without a stored gate decision for the current content hash raises a notice; the pickup re-check decides.
- [x] #6 A worktree or branch changed by hand under a running story parks it; `git worktree prune` runs only after confirmation.
- [x] #7 Scheduling stays off until reconcile of every loaded office finishes.
- [x] #8 Reconcile runs as a recovery step registered with the daemon's `recovering` state (DIPO-68) and when `office.rescan` (DIPO-72) runs.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S40 (DIPO-15). Moved before cutover in the M0 review (maintainer decision D14, DIPO-15). Before cutover: built by hand-run agents.

Follow-ups from DIPO-63 and DIPO-36 (2026-10-13): (1) release orphan claims at daemon start: a live claim whose run has no worker host (keep-awake stops counting it after CLAIM_START_WINDOW_MS, packages/engine/src/keepawake/activity.ts); (2) load every registered office at daemon start, so the merge slot poll and Done detection resume after a restart without waiting for an office command (a backlog PR open at restart otherwise waits).

Follow-up from the DIPO-36 and DIPO-74 live tests (2026-10-14): a fresh or lost state database does not know the office's open backlog PR (dipo/backlog-* branch, for example scratch PR #5), so the merge slot never merges it. Reconcile at daemon start should find open dipo/backlog-* PRs on the office's repository and adopt them into backlog_prs.

Implementation (2026-10-14):
- AC #2 first: the story index reads every story with a live claim (claim commit recorded, not released or torn down) inside the claim's worktree and mirrors it with the branch as backlog_mirror.source; a branch that cannot be read keeps the base read and is reported. The claim commit (work.run) and the park commit (run control) each trigger StoryIndex.refreshStory, a single-story re-read, so views and snapshots say In Progress or Parked at once (the park re-read is quiet: the park already emitted story.state). Regression: packages/engine/test/stories/branch.test.ts.
- packages/engine/src/reconcile/: reconcileOffice applies the 0007 section 6 rows after an index pass; Reconciler adds it as the last office load step and runs it on office.rescan (RunProfiles calls it after its index pass). Each mismatch writes its facts and an engine.notice in one transaction (codes reconcile.*).
- AC #1: OfficeManager already refuses the office at load when office.json differs; reconcile checks it again on every rescan and refuses the office (OfficeManager.refuse) with a notice.
- AC #6: git worktree list --porcelain -z plus the claimed branch refs and the claim's link snapshot; a running story parks scope-violation through RunControl.parkForReconcile, which writes nothing on the branch. Prunable worktrees only get a notice: dipo never runs git worktree prune itself, the maintainer confirms by running it.
- AC #7 and #8: a daemon recovery step named reconcile loads every registered office (also the DIPO-63 follow-up), so the merge slot and Done detection resume at start and the daemon enters running only after every office reconciled.
- Follow-up from DIPO-63/DIPO-36: at daemon start a live claim whose active run never got a worker host is released as orphaned (branch kept); a run directory with a launch file only gets a notice, since its host may have started without its row.
- Not done: adopting open dipo/backlog-* PRs after a lost database. It needs a new code-host listing and adoption into backlog_prs and the lane journal, and the structural check would fail without the lost gate decisions; proposed as its own story.
- Tests: fast local branch.test.ts and git-facts.test.ts; the per-row cases are packages/engine/test/reconcile/reconcile.ci.test.ts and the daemon start ordering is packages/daemon/test/integration/reconcile.ci.test.ts.
<!-- SECTION:NOTES:END -->
