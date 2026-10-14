---
id: DIPO-52
title: 'Derive story and work views, snapshots and a plain watch command'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 09:22'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-74
references:
  - packages/engine/src/views/
  - packages/engine/src/run/watchdog.ts
  - packages/engine/src/reads/
  - packages/cli/src/
  - packages/engine/test/views/
  - packages/engine/src/features.ts
  - packages/contract/
  - packages/engine/test/reads/
  - packages/client/src/client.ts
  - packages/client/test/
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

Context: evidence labels, the cost read and the digest read are M1. This story extends the minimal `deriveStoryView` and `OfficeSummary` of DIPO-32 with waiting-on, gate messages, work views and health; it replaces nothing else. The reads are added through the registration seam of DIPO-22 (M0 review, DIPO-15). References: 0005 sections 5 (views), 6 (derived only in the engine), 7 (reads), 8 (snapshot then subscribe without a gap); 0009 sections 3 (columns, health precedence, signals `quiet` and `no-output`), 9 (`dipo watch` plain text); 0008 section 3 (watchdog from `timeouts`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [ ] #6 `office.snapshot` reads stories, work and gates in one read transaction with its cursor, with questions joined by DIPO-59 and tests by M1 and empty lists until then; `story.detail` returns facts and past runs; `work.outputRange` returns stored text for a byte range.
- [ ] #7 `office.summary` events are sent after catch-up and debounced on change.
- [ ] #8 `dipo watch [ID]` prints phase, health, loop, verify and budget share, then streams `work.output` lines, without Ink.
- [ ] #9 The `story.detail` result shape that DIPO-20 drafted (`view`, `work?`, `runs`, `verdicts`) is checked against what the views serve and adjusted where needed before `v0.1.0`; after the first release it can only grow by additive fields.
- [ ] #10 The read `office.switch` (0005 section 7, 0009 section 4) is defined in the contract with the same args and result as `office.snapshot`, `since` set to the next unreleased contract minor (`CONTRACT_VERSION.minor` is bumped only when no unreleased bump exists yet), the schema files are regenerated with `bun run contract:schema`, and `commands.describe` lists it, and is registered in the engine as an alias of `office.snapshot`; a test shows both return the same snapshot. DIPO-20 left it undefined.
- [ ] #11 The client gets a liveness deadline on the injected clock: while subscribed, no frame for three idle `stream.mark` intervals (15 s each, 0005 section 8), or a pending request past its deadline, closes the connection and reconnects, so `dipo watch` notices a hung daemon (DIPO-25 review); a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S36 (DIPO-15). Before cutover: built by hand-run agents.

Follow-up from DIPO-74 (2026-10-14): derive the end of a run from runs.ended_at and runs.end_kind, not from a closing work.* event. A worker host that does not start ends its run as end_kind start-failed (the claim is released, the branch kept as released) and emits only an engine.notice run.startFailed, no closing work.* event; teardown and claim rollbacks also set ended_at and end_kind (their release reason).
<!-- SECTION:NOTES:END -->
