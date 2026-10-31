---
id: DIPO-394
title: Move story park and discard into run/ and the run's wiring into create/
status: Done
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-31 09:50'
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
  - packages/engine/src/box/safe-chain.ts
  - packages/engine/src/prompts/feedback.ts
priority: medium
type: chore
ordinal: 372000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `story.park`, `story.drop` and `work.discard` live with the run they stop, and the run's wiring lives in the composition root, so the last 3 value imports into a higher layer and the last directory cycle are gone.

Last move of the DIPO-381 plan (0004, 0020). `stories/planning.ts` and `stories/discard.ts` park and stop runs, so the story index would have to sit above the run; `run/compose.ts` wires the run with `questions/permissions.ts`, which sits above the run.
- Move `stories/planning.ts` and `stories/discard.ts` to `run/`, and `run/compose.ts` to `create/`. `run/index.ts` drops its re-exports of the moved files.
Removed back-edges (3 imports): stories -> run (planning and discard -> park: 2); run -> questions (compose -> permissions).
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --check` reports 0 back-edges and 0 directory cycles and exits 0.

```dipo
branch: "DIPO-394/park-discard-and-run-wiring"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --check reports 0 back-edges and 0 cycles"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `stories/planning.ts`, `stories/discard.ts` and `run/compose.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [x] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [x] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [x] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --check` reports 0 back-edges and 0 directory cycles on main after this story and exits 0
- [x] #5 The prompts -> box edge DIPO-376 added after the spike is gone: uniqueFound and the SafeChainFound type move from box/safe-chain.ts to prompts/ or a band-1 module, with their importers (box/workers.ts, prompts/feedback.ts and the test) following, so prompts imports nothing from box/ and the box/prompts cycle is broken
- [x] #6 run/index.ts no longer re-exports stories/planning and stories/discard from another directory (they move to run/ in this story, so the barrel re-exports its own files only)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved stories/planning.ts and stories/discard.ts into run/ and run/compose.ts into create/, and uniqueFound, SafeChainFound and its three types into prompts/safe-chain.ts. Only paths and import lines changed. The engine graph against the six target bands went from 3 back-edges, 4 statements and 2 cycles to 0, 0 and 0 (--check exits 0), so DIPO-395 can turn on the fine rule. Lint and bun run verify pass.
<!-- SECTION:FINAL_SUMMARY:END -->
