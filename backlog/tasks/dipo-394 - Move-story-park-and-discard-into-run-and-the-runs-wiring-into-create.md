---
id: DIPO-394
title: Move story park and discard into run/ and the run's wiring into create/
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:22'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
  - DIPO-393
references:
  - packages/engine/src/stories/planning.ts
  - packages/engine/src/stories/discard.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/create/
  - packages/engine/test/
  - .oxlintrc.json
priority: medium
type: chore
ordinal: 372000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `story.park`, `story.drop` and `work.discard` live with the run they stop, and the run's wiring lives in the composition root, so the last 3 value imports up a layer are gone.

Last move of the DIPO-381 plan (0004, 0020). `stories/planning.ts` and `stories/discard.ts` park and stop runs, so the story index would have to sit above the run; `run/compose.ts` wires the run with `questions/permissions.ts`, which sits above the run.
- Move `stories/planning.ts` and `stories/discard.ts` to `run/`, and `run/compose.ts` to `create/`. `run/index.ts` drops its re-exports of the moved files.
Removed back-edges (3 imports): stories -> run (planning and discard -> park: 2); run -> questions (compose -> permissions).
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict` lists no back-edge.

```dipo
branch: "DIPO-394/park-discard-and-run-wiring"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict reports 0 back-edges"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `stories/planning.ts`, `stories/discard.ts` and `run/compose.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict --files` lists none of the back-edges named in the description and no edge it did not list before the story
- [ ] #4 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #5 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict` reports 0 back-edges on main after this story
<!-- AC:END -->
