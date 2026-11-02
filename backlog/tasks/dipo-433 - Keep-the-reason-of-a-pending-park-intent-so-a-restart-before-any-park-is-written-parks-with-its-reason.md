---
id: DIPO-433
title: >-
  Keep a pending park's reason, so a restart before the park is written parks
  with it
status: Refined
assignee: []
created_date: '2026-11-02 14:12'
updated_date: '2026-11-02 14:30'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/control-types.ts
  - packages/engine/src/run/outcome-restart.ts
  - packages/engine/src/run/outcomes.ts
  - packages/engine/src/run/park.ts
  - packages/engine/test/run/
priority: medium
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: whatever made dipo decide to park a story (a cap, a failed verify, a question, a maintainer park), a daemon restart between that decision and the park still parks the story with the same reason and detail.

Proposed by the worker of DIPO-430 and accepted by the maintainer on 2026-11-02 (proposal a07157b4, DRAFT-12). DIPO-430 put the question text into the park intent's detail, so a restart before a question park is written still asks it. Other park reasons are not covered: the intent detail holds only the park detail (packages/engine/src/run/control-endings.ts about line 496 writes `ending.intentDetail ?? ending.detail`), not the reason, and the restart branch (packages/engine/src/run/outcome-restart.ts about line 143) parks from what the intent holds. A maintainer pause and a plan-limit hold already carry their own intent tags (outcome-restart.ts about lines 27-37, outcomes.ts).

Design: the park intent records the park reason in the same tagged intent detail DIPO-430 and the pause and plan-limit tags use (outcomes.ts), so no new column and no migration; the restart branch reads the reason and detail back and parks with them, falling back to today's behaviour for an intent written by an older binary. One intent format (0001). 0005, 0020.

```dipo
branch: "DIPO-433/park-intent-reason"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park intent stores its reason with its detail, and a restart between the intent and the park parks with that reason for every park reason"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For each park reason dipo writes through a park intent, a restart between the intent and the park parks the story with that reason and detail, shown by a test per reason that stops after the intent
- [ ] #2 An intent written before this change (no reason in it) still parks as today after a restart, shown by a test
- [ ] #3 The reason uses the tagged intent detail format of outcomes.ts, with no new column or migration, shown by the diff
<!-- AC:END -->
