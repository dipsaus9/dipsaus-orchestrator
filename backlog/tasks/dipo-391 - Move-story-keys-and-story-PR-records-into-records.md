---
id: DIPO-391
title: Move story keys and story PR records into records/
status: Refined
assignee: []
created_date: '2026-10-30 11:22'
updated_date: '2026-10-30 11:44'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-381
  - DIPO-390
references:
  - packages/engine/src/stories/keys.ts
  - packages/engine/src/story-pr/records.ts
  - packages/engine/src/records/
  - packages/engine/test/
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: chore
ordinal: 369000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: story keys and story PR records join the other stored facts in records/, so 16 value imports into a higher layer are gone.

Third move of the DIPO-381 plan (0004, 0005). `stories/keys.ts` (story identity) and `story-pr/records.ts` (PR rows) are read by views, commands, run, worktree and stories, which sit below the directories that hold them.
- Move `stories/keys.ts` to `records/story-keys.ts` and `story-pr/records.ts` to `records/story-prs.ts`.
Removed back-edges (16 imports): commands -> stories (keys); views -> stories (keys); views -> story-pr (2); run -> story-pr (6); stories -> story-pr (2); worktree -> story-pr (4, `worktree/git-facts.ts` included).
After this story `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json` reports 11 back-edges (26 import statements) on main as of 39d36f52.

```dipo
branch: "DIPO-391/keys-and-pr-records"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json lists no edge into stories/ or story-pr/ for keys or PR records"
    - kind: "automated"
      check: "(verify) bun run verify passes with the coarse engine-layers rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `stories/keys.ts` and `story-pr/records.ts` move with their tests, and every importer, barrel (`index.ts`), path-scoped override in .oxlintrc.json, lint test and comment that names an old path names the new one; no barrel re-exports a file from another directory
- [ ] #2 Only paths and import lines change: no function, type or behaviour changes, and no test is removed or skipped
- [ ] #3 The coarse dipo/engine-layers rule still passes with no exception, and `bun run verify` passes
- [ ] #4 `bun scripts/engine-graph.ts --layers scripts/engine-layers-target.json --files` lists none of the back-edges this story names as removed, and no import it did not list before the story
<!-- AC:END -->
