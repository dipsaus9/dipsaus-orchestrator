---
id: DIPO-356
title: Read and write stories only through a StoryStore interface
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-29 12:49'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/backlog/
  - packages/engine/src/stories/
  - packages/engine/src/run/
  - packages/engine/src/gate/
priority: medium
type: chore
ordinal: 336000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine reads and writes stories only through a StoryStore interface with one Backlog.md implementation, so another tracker could be added later without touching the rest of the engine.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit section 12, item 4; 0010 section 2a).

```dipo
branch: "DIPO-356/story-store-seam"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the engine tests pass with a fake StoryStore in place of Backlog.md"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 StoryStore offers listing and reading stories of a base or branch, and setting status, ticking criteria, writing the park reason and notes, the final summary, a resolved unknown and a draft
- [x] #2 The Backlog.md implementation holds the CLI runner, the story lane and the planning lane, and no other engine directory imports backlog/
- [x] #3 A lint rule fails an import of backlog/ from outside the store
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Part 1 merged in PR #431 (2026-10-29): the StoryStore interface, every read and the story lane writes, with the dipo/no-backlog-import lint rule. Part 2 (same story, a later PR): the planning lane behind the store (edit, hold, resume, drop and discard ops, an accepted proposal draft, journal reads, office init and the backlog PR merge inside backlog/), task-file layout facts as store methods, and the lint allow list emptied down to index.ts and features.ts; then criterion 2 is met. Review advisories for part 2: a fixture line for import = require(), and one contract suite run on both the fake and the Backlog store.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Stories are read and written only through the StoryStore interface. Part 1 (#431) added the interface, every read, the story-lane writes and the dipo/no-backlog-import lint rule. Part 2 (#432) moved the planning lane (hold, resume, drop, discard, to Refined, drafts, withdraw), the pickup guard, office init, the backlog PR auto-merge and the task-file layout facts into backlog/, emptied the lint allow list to index.ts and features.ts, and runs one contract suite on the fake and the Backlog store. Left for DIPO-379: the planning-journal read in run/park-state.ts and the plain backlog/ folder checks outside the store.
<!-- SECTION:FINAL_SUMMARY:END -->
