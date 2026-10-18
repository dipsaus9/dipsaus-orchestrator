---
id: DIPO-143
title: Take a run's caps from its start and its grants
status: Done
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-18 12:55'
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
  - packages/engine/src/ingest/
  - packages/engine/src/retention/
  - packages/daemon/src/runs.ts
  - packages/engine/test/run/
  - packages/engine/test/hooks/
  - packages/engine/test/ingest/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 132000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a run's caps are its start snapshot plus its recorded grants, read by one function everywhere, and a tier edit reaches new runs only, so no cap of a parked story changes without a recorded fact.

Context: implements ADR 0020 section 5 (caps come from the run, plus grants; maintainer decision 2) and the run_grants table of section 15. Today a resume reads caps from the office config in force (capsOf(tierOf(office, run)) in packages/daemon/src/runs.ts, 0020 fact 4), and runs stores budget_limit and loop_cap but no turn or minute cap. DIPO-146 adds the review loop's cap columns.

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
- [x] #1 runs gains max_turns and max_minutes, written at run start next to budget_limit and loop_cap, through a migration registered in db/schema.ts
- [x] #2 A new run_grants table (run, grant id, kind budget, loop, reviewRound, ciAttempt, conflictHandoff, reviewCap or scope, amount JSON, note, origin, client, at) exists with retention tier S with its run
- [x] #3 One function returns a run's caps as its snapshot plus the sum of its grants of each kind, and run control, the resumer, re-attach and the 80% budget nudge in hooks/nudges.ts read it
- [x] #4 A test edits the office tier while a run is parked and shows the resumed run keeps its start caps while a new run gets the edited caps
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M57F78TN92Q4J9ZBWRHRCNR9 (Haiku low, 36 turns, about $0.09, 6 min) reported done, In Review on DIPO-143/run-caps-from-start-and-grants, with no denied call. Migration 0032 adds runs.max_turns and runs.max_minutes and run_grants (amount JSON, 0020 section 15, tier S with its run); runCaps reads the start snapshot plus the grants.

Review blocked on four points, fixed on top on DIPO-143/run-caps-from-start-and-grants-finish: grant kinds now reach the right caps (reviewRound to the round cap; a budget grant carries tokens, turns and minutes and raises all three; reviewCap, ciAttempt and conflictHandoff grants are stored and wait for their caps, DIPO-146 and 0019); the resumer, re-attach and lost-usage recovery give ingest the budget from runCaps; a CI flow test (park-resume.ci.test.ts) parks a story, edits its tier in .dipo/office.yaml, resumes through RunResumer.next and checks the start caps hold while a new story takes the edited tier; per-reader grant tests for the nudge, run control and the resumer. The worker's commit had also broken the CI-only park.ci.test.ts budget-engine-cap case; the run office's caps override now goes into the start snapshot. Mutation checks: each reverted reader fails a test. Verify: 3337 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 on run, hooks, ingest, db and daemon: 646 pass. Re-review passed.

Follow-ups left: packages/engine/src/views/work.ts:198 still passes run.budgetLimit to readUsage, so the work view's budget leaves out grants (outside the References; fold into DIPO-156); a resumed or re-attached session still takes model and effort from the tier in force (snapshot effort on runs).
<!-- SECTION:NOTES:END -->
