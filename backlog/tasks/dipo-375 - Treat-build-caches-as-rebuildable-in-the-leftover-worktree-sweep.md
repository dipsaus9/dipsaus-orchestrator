---
id: DIPO-375
title: Treat build caches as rebuildable in the leftover worktree sweep
status: Done
assignee: []
created_date: '2026-10-29 09:29'
updated_date: '2026-10-30 09:11'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/worktree/leftovers.ts
  - packages/engine/src/config/
modified_files:
  - packages/engine/schema/office.schema.json
  - packages/engine/src/config/schema.ts
  - packages/engine/src/worktree/feature.ts
  - packages/engine/src/worktree/index.ts
  - packages/engine/src/worktree/leftovers.ts
  - packages/engine/test/config/load.test.ts
  - packages/engine/test/config/schema.test.ts
  - packages/engine/test/worktree/leftovers.test.ts
priority: medium
type: bug
ordinal: 355000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a leftover story worktree of an earlier binary that differs only by ignored build caches is removed at office load, while anything else that git does not hold still keeps it.

Found on 2026-10-29 when this repository was opened as an office for the cutover: the DIPO-349 sweep (worktree/leftovers.ts) kept 12 of 15 old worktrees only because of ignored `.tsbuild/` folders (tsc -b output) and `.claude/.cc-writes/`. Only `node_modules/` and `.DS_Store` count as rebuildable today. 0010.

```dipo
branch: "DIPO-375/leftover-build-caches"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, real git) a leftover with only a rebuildable build cache and saved files is removed; one with an ignored env file is kept"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The office configuration names ignored paths that are rebuildable (default: node_modules/, .DS_Store, .tsbuild/ and .claude/.cc-writes/), matched as a folder at any depth or as an exact nested path, and the sweep removes a leftover whose other paths are all saved in git
- [x] #2 An ignored path not on that list, such as .env, still keeps the worktree, with a test against real git, and so does every case the sweep keeps today (a change git does not hold, a detached HEAD, more than 500 changed paths)
- [x] #3 The desk text of a kept leftover lists only the paths that keep it
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-30 09:11 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 89,568 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
