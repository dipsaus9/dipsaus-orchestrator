---
id: DIPO-453
title: >-
  Show a retro view in the TUI with parks, rounds, cost, time and where stories
  came from
status: Refined
assignee: []
created_date: '2026-11-05 20:52'
updated_date: '2026-11-06 09:42'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-452
  - DIPO-454
  - DIPO-443
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/records/run-records.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/overview/
  - packages/contract/src/office.ts
  - packages/tui/src/
  - docs/decisions/0007-state-database.md
priority: medium
type: feature
ordinal: 426000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a retro view in the TUI that shows why stories parked, how many fix rounds and loops they took, what they cost, how long they took, where they came from and how much was rework, so that I can prepare work better.

M3 (0022). Needs DIPO-452 and DIPO-454 for the origin of new stories (the audit and accept record it), and for the rejected ideas and dismissed proposals (stories from before it show origin unknown) and DIPO-443 for the view.

dipo computes every number by code from its database (0007); a planning session may explain them, never compute them, and gets them as text in its first message once this lands. What exists: run_outcomes keeps park reasons, loops, review, CI and conflict rounds, budget tokens and minutes; usage_daily keeps cost by role, tier and model (packages/engine/src/db/migrations/0001-base.ts, packages/engine/src/retention/policy.ts). Missing and kept from now on: cost and story key per run outcome, the time a story became Ready, and the story's origin.

Rework (maintainer's rule, 2026-11-05): a merged story counts as rework when most of the files it changed were changed by another story merged in the 14 days before it.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-453/retro-view"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) retro numbers from a fixture database: park reasons with counts, rounds and loops, cost and Ready-to-merged time per tier and type, origin breakdown, rework share, rejected ideas by reason and dismissed proposals"
    - kind: "automated"
      check: "(unit) new run outcomes keep cost and story key, a story keeps when it became Ready, and retention keeps them"
    - kind: "automated"
      check: "(unit) TUI test: the retro view renders the numbers per tier and type"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo keeps, per run outcome, its cost and story key, per story the time it became Ready, and per story its origin
- [ ] #2 A retro view in the TUI shows, per tier and type, park reasons with counts, fix rounds and loops, cost and time from Ready to merged
- [ ] #3 The view shows where stories came from (planned, worker proposal, reviewer advisory, quick idea, session aside, unknown) and the share of rework by the 14-day file rule
- [ ] #4 Every number is computed by code from the database with no model call, and a planning session gets them as text
- [ ] #5 The view shows how many ideas the audit rejected, grouped by reason, and how many proposed stories the maintainer dismissed
<!-- AC:END -->
