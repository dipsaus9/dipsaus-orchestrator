---
id: DIPO-381
title: Set the engine's directory layers and the moves that remove the back-edges
status: To Do
assignee: []
created_date: '2026-10-29 16:54'
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
- [ ] #1 0004 names a layer for every engine directory and the order between them, with the reason for each placement, approved by the maintainer
- [ ] #2 Each of the 31 measured back-edges is resolved in the plan by a named move, split or port (for example splitting run/ or moving the shared view types down), filed as implementation stories
- [ ] #3 The last of those stories turns the fine dipo/engine-layers rule on with no exception and removes the coarse domain layer
<!-- AC:END -->
