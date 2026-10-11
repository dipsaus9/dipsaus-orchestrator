---
id: DIPO-52
title: 'Derive story and work views, snapshots and a plain watch command'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-48
references:
  - packages/engine/src/views/
  - packages/engine/src/run/watchdog.ts
  - packages/engine/src/reads/
  - packages/cli/src/
  - packages/engine/test/views/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine derives `StoryView` (column, waiting-on, gate messages), `WorkView` (phase, progress, usage with budget share, health from watchdog signals) and `OfficeSummary` from facts, serves `office.snapshot`, `story.detail` and `work.outputRange`, and `dipo watch [ID]` prints a running story's state and live output as plain text.

Context: evidence labels, the cost read and the digest read are M1. References: 0005 sections 5 (views), 6 (derived only in the engine), 7 (reads), 8 (snapshot then subscribe without a gap); 0009 sections 3 (columns, health precedence, signals `quiet` and `no-output`), 9 (`dipo watch` plain text); 0008 section 3 (watchdog from `timeouts`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-52/derive-story-work-views-snapshots-plain"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `stall` replay produces `quiet` then `no-output` and health `stuck`."
    - kind: "automated"
      check: "(engine) snapshot cursor plus subscribe after it yields every later event once."
    - kind: "automated"
      check: "(unit) column and health derivation tables."
    - kind: "manual"
      check: "during a scratch run, `dipo watch <ID>`"
      expect: "worker output lines appear within a second of the worker writing them."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Views are computed only in engine code from facts and are written as the `view` of each change-log entry; no view is stored as truth.
- [ ] #2 `StoryView.column` is one of the nine 0009 columns; a Ready story whose dependency is not Done is `waiting` with `waitingOn`.
- [ ] #3 The watchdog writes `work.observed quiet` after `workerQuietMinutes` and `no-output` after `workerStallMinutes` without a line, on the injected clock, and clears `quiet` on the next line.
- [ ] #4 Health follows the 0009 precedence over the facts M0 records (`lost`, `limited`, `looping`, `stuck`, `quiet`, `busy`).
- [ ] #5 `Usage.budgetShare` is used divided by limit in tokens.
- [ ] #6 `office.snapshot` reads stories, work, gates, questions and tests in one read transaction with its cursor; `story.detail` returns facts and past runs; `work.outputRange` returns stored text for a byte range.
- [ ] #7 `office.summary` events are sent after catch-up and debounced on change.
- [ ] #8 `dipo watch [ID]` prints phase, health, loop, verify and budget share, then streams `work.output` lines, without Ink.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S36 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
