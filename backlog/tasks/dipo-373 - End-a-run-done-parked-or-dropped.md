---
id: DIPO-373
title: 'End a run done, parked or dropped'
status: Refined
assignee: []
created_date: '2026-10-29 09:28'
updated_date: '2026-10-29 09:33'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
  - DIPO-352
references:
  - packages/engine/src/run/
  - packages/contract/src/
  - packages/engine/src/db/
priority: medium
type: chore
ordinal: 353000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a run ends done, parked with its reason, or dropped, and no endKind string, worker outcome or park cause describes an ending any more.

Split from DIPO-352 (criterion 3) on 2026-10-29; its part 1 (health and phases) is PR #427. 0020 'How a run ends' decides the open questions: a run at In Review is not ended, it stays open in phase review, test or merge until its story is Done; start-failed, where the story goes back to Ready, is dropped (a discard, 0020 section 5); reconciled and recorded, a story finished outside dipo, are done (0020 section 7). Code that decides from in-review or reviewed endings today (merge, PR, fix rounds, test, conflicts) reads the run's phase instead. run_outcomes history is migrated to the three endings. 0005, 0007.

```dipo
branch: "DIPO-373/three-run-endings"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) nextRunState ends runs only as done, parked or dropped, and keeps an In Review run open in its phase"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A run ends done, parked with one of the eight reasons, or dropped, decided in nextRunState (run/lifecycle.ts), and a run at In Review stays open in phase review, test or merge until its story is Done
- [ ] #2 start-failed ends dropped and returns the story to Ready; reconciled and recorded end done
- [ ] #3 Merge, PR, fix-round, test and conflict code decide from the run's phase and the story's status; the end kinds in-review, reviewed, start-failed, reconciled and recorded are removed, and no worker outcome or park cause names an ending
- [ ] #4 run_outcomes rows are migrated to the three endings by a migration tested on a database with rows, and fresh equals migrated
<!-- AC:END -->
