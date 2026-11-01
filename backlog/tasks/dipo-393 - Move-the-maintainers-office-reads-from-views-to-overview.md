---
id: DIPO-393
title: Move the maintainer's office reads from views/ to overview/
status: Done
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-31 08:38'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
  - DIPO-392
  - DIPO-380
references:
  - packages/engine/src/views/
  - packages/engine/src/overview/
  - packages/engine/src/backlog/pr/desk.ts
  - packages/engine/src/features.ts
  - packages/engine/src/create/
  - packages/engine/test/
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 371000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: views/ holds only the work, story and usage views derived from facts, and the snapshot, desk, digest and summary reads sit in overview/ among the services, so 12 value imports into a higher layer are gone.

Fifth move of the DIPO-381 plan (0004, 0005, 0009, 0020). The run and every writer import `views/work.ts` and `views/story.ts`; the desk and the snapshot read import the run, so the two halves of views/ belong to two bands.
- Move `views/desk.ts`, `digest.ts`, `feature.ts`, `summary.ts`, `proposals.ts` and `desk-notify.ts` to a new `overview/`; `views/index.ts` re-exports only what stays. Update `backlog/pr/desk.ts`, `features.ts` and `create/`. Add `overview` to the coarse domain layer.
Removed back-edges (12 imports): views -> run-state (desk, feature, summary: 3, left by DIPO-392); views -> ingest (feature -> markers, left by DIPO-392); views -> run (conflicts, done-report, starts-paused, test-records: 5 imports from desk and feature); views -> scan (desk); views -> worktree (desk: 2).
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json` reports 2 back-edges (3 import statements) on main as of 39d36f52.
Depends on DIPO-380, which changes the desk read.

```dipo
branch: "DIPO-393/office-reads-in-overview"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json lists no edge from views/ into run/, run-state/, ingest/, scan/ or worktree/"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The six desk and read files of `views/` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [x] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [x] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [x] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --files` lists none of the back-edges this story names as removed, and no import it did not list before the story
- [x] #5 `views/` imports values only from bands 1 to 3 of 0004 and from directories below it in the target order, as `bun scripts/engine-graph.ts` shows
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fifth engine-layer move of the DIPO-381 plan, paths and import lines only: views/desk, digest, feature, summary, proposals and desk-notify moved to a new overview/ (its barrel re-exports only its own files; views/ keeps story, work and usage). Against the target layers 8 back-edges (16 statements) became 3 (4); the 12 named imports are gone, including the four DIPO-392 left (views -> run-state, views -> ingest), and none was added. Left for DIPO-394: prompts -> box, run/compose -> questions, stories -> run/park twice. The worker host ban covers overview and its barrel, with lint fixtures. Checked by the orchestrating session (graph, lint, non-import lines) instead of an agent review, per the maintainer review-by-risk rule of 2026-10-31.
<!-- SECTION:FINAL_SUMMARY:END -->
