---
id: DIPO-393
title: Move the maintainer's office reads from views/ to overview/
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
Outcome: views/ holds only the work, story and usage views derived from facts, and the snapshot, desk, digest and summary reads sit in overview/ at the top of the services, so 13 value imports up a layer are gone.

Fifth move of the DIPO-381 plan (0004, 0005, 0009, 0020). The run and every writer import `views/work.ts` and `views/story.ts`; the desk and the snapshot read import the run, so the two halves of views/ need two layers.
- Move `views/desk.ts`, `digest.ts`, `feature.ts`, `summary.ts`, `proposals.ts` and `desk-notify.ts` to a new `overview/`; `views/index.ts` re-exports only what stays. Update `backlog/pr/desk.ts`, `features.ts` and `create/`. Add `overview` to the coarse domain layer.
Removed back-edges (13 imports): views -> questions (desk, feature, summary: 3); views -> review (feature); views -> run (conflicts, done-report, markers, starts-paused, test-records: 6 imports from desk and feature); views -> scan (desk); views -> worktree (desk: 2).
Depends on DIPO-380, which changes the desk read.

```dipo
branch: "DIPO-393/office-reads-in-overview"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict lists no edge from views/ into run/, questions/, review/, scan/ or worktree/"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The six desk and read files of `views/` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --strict --files` lists none of the back-edges named in the description and no edge it did not list before the story
- [ ] #4 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #5 `views/` imports values only from layers 1 to 5 of 0004 and from itself, as `bun scripts/engine-graph.ts --files` shows
<!-- AC:END -->
