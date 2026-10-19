---
id: DIPO-146
title: Judge review reports and key verdicts on the code tree
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 21:08'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-139
  - DIPO-140
  - DIPO-145
references:
  - packages/engine/src/review/
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/views/feature.ts
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/engine/test/review/
  - packages/engine/test/db/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: code validates each reviewer report, computes the verdict and stores it in review_verdicts and as a review gate keyed on the code tree key, and the review loop's caps are snapshot on the run at its start.

Context: implements ADR 0019 section 5 (validation and verdict), the verdict keyed on the reviewed commit and its code tree key of section 6, the caps snapshot of section 4, and the review_verdicts table and runs columns of section 16; 0020 section 5 fixes every cap at run start. Today runs.review_round_cap is written as null and nothing writes a review step (0019 fact 6), and review_verdicts has no migration (fact 7).

DIPO-219 builds on this story: the pending-review starter, no review of a code tree key that has a verdict, the review allowance per round, the review-blocked park and the section 4 failure table. DIPO-149 and DIPO-150 record their own clean base merges so a review approval carries over them (0019 section 6). This story gives that work the report validation and the verdict as functions of the report, the story's criteria and test plan and the story's diff at the reviewed commit, and a store that writes and reads verdicts by code tree key.

```dipo
branch: "DIPO-146/judge-review-reports-and-verdicts"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) validation: a missing criterion, a quote that differs from the line, a line outside the diff and a test finding naming a manual entry"
    - kind: "automated"
      check: "(unit) verdict computation and the advisory rule for blocking maintainability findings"
    - kind: "automated"
      check: "(unit) a stored verdict is read back by its code tree key with its validation notes, comment URL, carried-from commit and override, and story.detail shows it as Verdict.review"
    - kind: "automated"
      check: "(migration) review_verdicts and the runs cap columns exist and are written at run start"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A report is valid only with exactly one criteria entry per story criterion and evidence for unmet and maintainer; a blocking scope, security or correctness finding needs a changed file, a line inside a hunk of the story's diff and a quote equal to that line after trimming, a blocking test finding needs the number of an automated test-plan entry, and blocking maintainability or other findings are stored as advisory
- [ ] #2 The verdict is blocked when a criterion is unmet or a validated blocking finding exists, else approved; it is stored in review_verdicts (retention tier S, with validation notes, comment URL, carried-from commit and override) and as a review gate keyed on the code tree key, and story.detail shows it as Verdict.review
- [ ] #3 A migration adds runs.ci_cap, conflict_cap, review_max_turns, review_max_minutes and review_allowance, and these with review_round_cap are written from review.maxRounds, maxTurns, maxMinutes, budgetTokens and mergeSlot.ciAttempts and conflictAttempts at run start
<!-- AC:END -->
