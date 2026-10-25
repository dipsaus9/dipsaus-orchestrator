---
id: DIPO-356
title: Read and write stories only through a StoryStore interface
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
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
- [ ] #1 StoryStore offers listing and reading stories of a base or branch, and setting status, ticking criteria, writing the park reason and notes, the final summary, a resolved unknown and a draft
- [ ] #2 The Backlog.md implementation holds the CLI runner, the story lane and the planning lane, and no other engine directory imports backlog/
- [ ] #3 A lint rule fails an import of backlog/ from outside the store
<!-- AC:END -->
