---
id: DIPO-400
title: Name each feature module after its directory
status: Refined
assignee: []
created_date: '2026-10-30 22:14'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-394
references:
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/backlog/init/init.ts
  - packages/engine/src/features.ts
priority: low
type: chore
ordinal: 378000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every engine feature module registers under the name of the directory it lives in, so a registration error names the right place.

Found by the review of PR #486 (DIPO-389): the story.gate feature moved to gate-decisions/ but still registers as "gate/store" (gate-decisions/feature.ts), and backlog/init/init.ts registers "office/init". The layer moves left the names alone on purpose, since changing them changes error text. 0004, 0001.

```dipo
branch: "DIPO-400/feature-names-follow-dirs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a test lists every registered feature name and checks it matches its module directory"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every feature module registers under its directory's name (gate-decisions, backlog/init and any other stale name found), and no test or message still names the old ones
- [ ] #2 A test reads every registered feature name and fails when one does not match its module's directory
<!-- AC:END -->
