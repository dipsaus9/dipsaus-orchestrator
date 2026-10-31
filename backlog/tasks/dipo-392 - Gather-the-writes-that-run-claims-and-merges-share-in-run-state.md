---
id: DIPO-392
title: 'Gather the writes that run, claims and merges share in run-state/'
status: Done
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-31 08:06'
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
Outcome: the run-state writes that the run, claims, merges, stories and retention share sit in run-state/ below worktree, and phase markers sit in ingest/, so 11 value imports into a higher layer are gone.

Fourth move of the DIPO-381 plan (0004, 0005, 0020). These modules write facts with their change-log entries and views, so they sit above views and below worktree and run.
- Move to a new `run-state/`: `run/rounds.ts`, `run/places.ts`, `run/pre-start-caps.ts`, `run/park-records.ts`, `merge/gates.ts` and `questions/questions.ts`. Add `run-state` to the coarse domain layer of ENGINE_LAYERS.
- Move `run/markers.ts` to `ingest/markers.ts`: a phase marker is a line of the worker output, stored as ingest stores output.
Removed back-edges (11 imports): run -> merge (tests -> merge gates); run -> questions (park, park-records, park-resume: 3); stories -> questions (discard); stories -> run (planning -> park-records); worktree -> merge (done -> merge gates); worktree -> questions (done-elsewhere); worktree -> run (claim and records -> markers, done-elsewhere -> park-records: 3).
Four imports change directory pair and stay back-edges until DIPO-393 moves their importers to overview/: views -> run-state (`views/desk.ts`, `views/feature.ts` and `views/summary.ts` import `questions.ts`: 3) and views -> ingest (`views/feature.ts` imports `markers.ts`: 1).
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json` reports 7 back-edges (15 import statements) on main as of 39d36f52.

```dipo
branch: "DIPO-392/shared-run-state-writes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json lists no edge from worktree, stories or run into merge/ or questions/ for the moved files, and from views only the four named imports into run-state/ and ingest/"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The six run-state files and `run/markers.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [x] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [x] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [x] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --files` lists none of the back-edges this story names as removed, and no import it did not list before the story, except exactly these four, which DIPO-393 removes: views -> run-state from `views/desk.ts`, `views/feature.ts` and `views/summary.ts` (questions), and views -> ingest from `views/feature.ts` (markers)
- [x] #5 `run-state/` imports values only from bands 1 to 4 of 0004 and from directories below it in the target order, as `bun scripts/engine-graph.ts` shows
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fourth engine-layer move of the DIPO-381 plan, paths and import lines only: a new run-state/ holds rounds, places, pre-start caps, park records, merge gates and questions (its barrel re-exports only its own files), and run/markers.ts moved to ingest/. Against the target layers 12 back-edges (27 statements) became 8 (16); the 11 named imports are gone, and the four allowed new ones (views -> run-state 3, views -> ingest 1) wait for DIPO-393. The worker host ban covers run-state and its barrel, and the adapter-neutral questions boundary covers run-state/questions.ts, each proven by a lint fixture. The extra prompts -> box edge stays with DIPO-394.
<!-- SECTION:FINAL_SUMMARY:END -->
