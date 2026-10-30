---
id: DIPO-381
title: Set the engine's directory layers and the moves that remove the back-edges
status: Done
assignee: []
created_date: '2026-10-29 16:54'
updated_date: '2026-10-30 12:16'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-318
references:
  - packages/engine/src/
  - tools/lint/oxlint-plugin.js
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: spike
ordinal: 361000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine's directories have a written layer order with no back-edges, decided in 0004, and a plan of the moves that gets the code there, so the fine `dipo/engine-layers` rule can be turned on.

Split from DIPO-318 criterion 7 on 2026-10-29. Its builder measured the import graph on main: twenty engine directories sit in one import cycle (box, commands, db, gate, hooks, ingest, merge, office, pricing, prompts, reconcile, retention, review, run, runs, scan, stories, story-pr, views, workers, worktree), and git and platform form a second small cycle. run/ is the hub: it imports views 33 times and views imports it 16 times; merge, story-pr, stories, worktree, hooks, gate and reconcile all import it back. db/ imports prompts (two migrations) and pricing; box and workers import each other. The best order found still leaves 31 back-edges (94 import statements). Until this lands, DIPO-318 turns on a coarse rule: base directories, one domain layer, then create/. 0004, 0005, 0003. It removes the coarse domain layer once the fine layers are in place.

```dipo
branch: "DIPO-381/engine-layers"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(lint) the fine dipo/engine-layers rule passes on main with no exception after the planned moves"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The import graph of packages/engine/src is measured again by a script kept in the repository, so the numbers can be re-checked (the 2026-10-29 count was the DIPO-318 builder's: 31 back-edges, 94 import statements)
- [x] #2 0004 is rewritten to name a layer for every engine directory and the order between them, with the reason for each placement, plus one line in its Replaced list; the maintainer approves the ADR change before merge
- [x] #3 Each measured back-edge, and the git/platform cycle, is resolved in the plan by a named move, split or port (for example splitting run/ or moving the shared view types down), filed as implementation stories
- [x] #4 The last of those stories turns the fine dipo/engine-layers rule on with no exception, removes the coarse domain layer, and adds a test/lint-boundaries/ fixture per layer boundary
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
scripts/engine-graph.ts measures the engine's directory import graph (value vs type imports, cycles, back-edges against a layer order, --check). On main: 38 directories, 225 value edges, 816 import statements, an 18-directory cycle with run/ as the hub and a backup/db/retention cycle; the git/platform cycle was already gone. ADR 0004 now describes six bands (base; checks and texts; facts and boxes; views and writers; run and services; composition) with the reason for each, and two rules: no directory cycles, nothing imports a value from a higher band; the lint plugin keeps the fine order; approved by the maintainer on 2026-10-30. Against the target order, 29 back-edges (74 statements) and 2 cycles are each assigned to DIPO-389 to DIPO-394, replayed on the file graph so each story merges alone; DIPO-395 turns the rule and the cycle check on and removes the coarse domain layer.
<!-- SECTION:FINAL_SUMMARY:END -->
