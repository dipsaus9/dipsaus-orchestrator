---
id: DIPO-138
title: Move park resume and work.resume out of RunOutcomes into one resume module
status: Done
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-17 22:29'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
  - DIPO-128
references:
  - packages/engine/src/run/
  - packages/engine/src/hooks/park-answers.ts
  - packages/engine/test/run/
  - packages/daemon/src/runs.ts
priority: high
type: task
ordinal: 127000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: park resume and work.resume live in one module with a per-reason policy table, and RunOutcomes no longer holds them, with behaviour unchanged, so the M1a resume rows and the review loop's reopened runs extend one path.

Context: implements ADR 0020 section 1 (one resume path for every park), last paragraph: work.resume moves out of run/plan-limit.ts and park resume out of RunOutcomes before it grows (2026-10-16 review, CC3). Today a needs-permission park resumes through RunOutcomes.resumePark in run/outcomes.ts, called from hooks/park-answers.ts, and work.resume is registered in run/plan-limit.ts. The ADR allows folding this into DIPO-128; it is filed on its own because DIPO-142 (run reopen and session places) depends on it.

```dipo
branch: "DIPO-138/move-park-resume-out-of-run-outcomes"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the policy table resumes a needs-permission park on its answer and a plan-limit hold on work.resume, and answers story.notPausedOrParked for every other park reason"
    - kind: "automated"
      check: "(unit) the existing run and park-answer tests pass unchanged against the new module"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 work.resume for held runs and park resume (lift the park on the branch, reopen the run, start the next session) are implemented in one module under packages/engine/src/run/, and run/outcomes.ts no longer contains park resume code
- [x] #2 The module decides through a policy table keyed by park reason; in this story the table holds the M0 rows only (needs-permission through the permission answer, plan-limit holds through work.resume) and every other reason still answers story.notPausedOrParked
- [x] #3 hooks/park-answers.ts and packages/daemon/src/runs.ts call the new module for a resume, not RunOutcomes
- [x] #4 Behaviour is unchanged: the existing run, park-answer and plan-limit tests pass without changes to their assertions, and the CI-only run tests pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55Z0GHGBN2YQ85CM5HMA9MX (Sonnet medium, 71 turns, about $1.41, 7 min) reported done. Park resume and work.resume live in run/resumption.ts (Resumption: resumeWait, resumePark, recoverParkResumes, the work.resume handler); outcome-resumes.ts is gone. PARK_RESUME_POLICY with resumeVia holds the M0 rows (needs-permission through the permission answer, plan-limit through work.resume); any other reason answers story.notPausedOrParked. RunOutcomes reaches park recovery through a recoverParks dependency. Tests moved their construction and calls from outcomes to resumption; assertions unchanged. Left for later: packages/daemon/src/foreground.ts still registers work.resume through runs.planLimits.feature, which delegates to the resumption. Verify outside the sandbox on DIPO-138/move-park-resume-out-of-run-outcomes-finish: 3192 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 run, hooks and daemon 517 pass.
<!-- SECTION:NOTES:END -->
