---
id: DIPO-392
title: 'Gather the writes that run, claims and merges share in run-state/'
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:22'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
  - DIPO-391
references:
  - packages/engine/src/run/rounds.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/park-records.ts
  - packages/engine/src/merge/gates.ts
  - packages/engine/src/questions/questions.ts
  - packages/engine/src/run/markers.ts
  - packages/engine/src/run-state/
  - packages/engine/test/
  - tools/lint/oxlint-plugin.js
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 370000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run-state writes that the run, claims, merges, stories and retention share sit in run-state/ below worktree, and phase markers sit in ingest/, so 12 value imports up a layer are gone.

Fourth move of the DIPO-381 plan (0004, 0005, 0020). These modules write facts with their change-log entries and views, so they sit above views and below worktree and run.
- Move to a new `run-state/`: `run/rounds.ts`, `run/places.ts`, `run/pre-start-caps.ts`, `run/park-records.ts`, `merge/gates.ts` and `questions/questions.ts`. Add `run-state` to the coarse domain layer of ENGINE_LAYERS.
- Move `run/markers.ts` to `ingest/markers.ts`: a phase marker is a line of the worker output, stored as ingest stores output.
Removed back-edges (12 imports): retention -> run (park-records); run -> merge (tests -> merge gates); run -> questions (park, park-records, park-resume: 3); stories -> questions (discard); stories -> run (planning -> park-records); worktree -> merge (done -> merge gates); worktree -> questions (done-elsewhere); worktree -> run (claim and records -> markers, done-elsewhere -> park-records: 3).

```dipo
branch: "DIPO-392/shared-run-state-writes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict lists no edge from worktree, stories or retention into run/, merge/ or questions/ for the moved files"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The six run-state files and `run/markers.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict --files` lists none of the back-edges named in the description and no edge it did not list before the story
- [ ] #4 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #5 `run-state/` imports values only from layers 1 to 7 of 0004 and from itself, as `bun scripts/engine-graph.ts --files` shows
<!-- AC:END -->
