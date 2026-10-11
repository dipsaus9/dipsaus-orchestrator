---
id: DIPO-56
title: Reconcile the database with Backlog.md and git at daemon start
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-32
  - DIPO-38
  - DIPO-50
references:
  - packages/engine/src/reconcile/
  - packages/engine/test/reconcile/
documentation:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
priority: medium
type: feature
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: in the daemon's `recovering` state and on `office.rescan`, the engine compares its database with Backlog.md and git per the 0007 section 6 table, writes each mismatch as facts with an `engine.notice`, and changes nothing silently.

References: 0007 section 6 (steps 1 to 6, table); 0001 "Data ownership"; 0005 section 2 (identity), open question 7; 0010 failure case "worktree or branch changed by hand".

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-56/reconcile-database-backlog-md-git-at"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) one test per row of the 0007 section 6 table with a fixture mismatch, asserting the facts and the notice."
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
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S40 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
