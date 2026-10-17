---
id: DIPO-143
title: Take a run's caps from its start and its grants
status: Refined
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-17 12:51'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-138
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/run/
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/retention/
  - packages/daemon/src/runs.ts
  - packages/engine/test/run/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 132000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a run's caps are its start snapshot plus its recorded grants, read by one function everywhere, and a tier edit reaches new runs only, so no cap of a parked story changes without a recorded fact.

Context: implements ADR 0020 section 5 (caps come from the run, plus grants; maintainer decision 2) and the run_grants table of section 15. Today a resume reads caps from the office config in force (capsOf(tierOf(office, run)) in packages/daemon/src/runs.ts, 0020 fact 4), and runs stores budget_limit and loop_cap but no turn or minute cap. 0019 story G adds the review loop's cap columns.

```dipo
branch: "DIPO-143/run-caps-from-start-and-grants"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the caps function adds budget, loop and reviewCap grants to the start snapshot"
    - kind: "automated"
      check: "(unit) a tier edit during a park leaves the resumed run's caps unchanged and reaches a new run"
    - kind: "automated"
      check: "(migration) runs.max_turns, runs.max_minutes and run_grants exist with their retention tier"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runs gains max_turns and max_minutes, written at run start next to budget_limit and loop_cap, through a migration registered in db/schema.ts
- [ ] #2 A new run_grants table (run, grant id, kind budget, loop, reviewRound, ciAttempt, conflictHandoff, reviewCap or scope, amount JSON, note, origin, client, at) exists with retention tier S with its run
- [ ] #3 One function returns a run's caps as its snapshot plus the sum of its grants of each kind, and run control, the resumer, re-attach and the 80% budget nudge in hooks/nudges.ts read it
- [ ] #4 A test edits the office tier while a run is parked and shows the resumed run keeps its start caps while a new run gets the edited caps
<!-- AC:END -->
