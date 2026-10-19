---
id: DIPO-146
title: Judge review reports and key verdicts on the code tree
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 15:14'
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
priority: high
type: feature
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: code validates each reviewer report, computes the verdict and stores it keyed on the code tree, skips the re-reviews ADR 0019 section 6 allows, adds the review allowance per round, parks review-blocked after the third failed round and handles reviewer failures, with the review loop's caps snapshot on the run at its start.

Context: implements ADR 0019 section 5 (validation and verdict), section 6 (rounds, review keyed on the commit, when re-review is skipped), the failure table and caps of section 4, and the review_verdicts table and runs columns of section 16; 0020 section 5 fixes every cap at run start. Today runs.review_round_cap is written as null and nothing writes a review step (0019 fact 6), and review_verdicts has no migration (fact 7).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). This story registers the pending-review starter: the review starter (START_KINDS.review) for the reviewer place, fed through PlacesDeps.pending, which places.ts documents as 0019 story G. A waiting start whose kind has no starter blocks its place, so the starter and the pending reviews land together. 0019 section 12 orders pending reviews by oldest In Review, so the order needs only the wait time (a pending start's since, or runs.waiting_since) to equal the In Review time. reopenForRound (packages/engine/src/run/rounds.ts) uses its at for the reopen, the review phase step and waiting_since alike, so passing the In Review time as at would also back-date the reopen and the phase step; pass the wait time separately. A failed review round appends the review-failed run_steps kind that the final run_outcomes row counts. The review-resume starter (a maintainer resume that starts a fresh review, 0020 section 2) belongs to DIPO-157.

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
      check: "(unit) a code tree key with a verdict is not reviewed again after a restart, and a clean engine sync carries the approval"
    - kind: "automated"
      check: "(unit) each row of the section 4 failure table, including the third failed round parking review-blocked"
    - kind: "automated"
      check: "(migration) review_verdicts and the runs cap columns exist and are written at run start"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A report is valid only with exactly one criteria entry per story criterion and evidence for unmet and maintainer; a blocking scope, security or correctness finding needs a changed file, a line inside a hunk of the story's diff and a quote equal to that line after trimming, a blocking test finding needs the number of an automated test-plan entry, and blocking maintainability or other findings are stored as advisory
- [ ] #2 The verdict is blocked when a criterion is unmet or a validated blocking finding exists, else approved; it is stored in review_verdicts (retention tier S, with validation notes, comment URL, carried-from commit and override) and as a review gate keyed on the code tree key, and story.detail shows it as Verdict.review
- [ ] #3 No review starts for a code tree key that already has a verdict in the claim, across a daemon restart; an approved head plus an engine-made clean base merge and task-file commits carries the approval to the new head
- [ ] #4 Each review round started writes a run_steps review step and grows the run's budget limit by review_allowance; a retried session of the same round adds nothing
- [ ] #5 The third failed round parks review-blocked with cause rounds and the blocking findings as detail; reviewer failures follow the section 4 table, with causes review, review-cap and backstop and one correction turn for an invalid report or unverified evidence
- [ ] #6 A migration adds runs.ci_cap, conflict_cap, review_max_turns, review_max_minutes and review_allowance, and these with review_round_cap are written from review.maxRounds, maxTurns, maxMinutes, budgetTokens and mergeSlot.ciAttempts and conflictAttempts at run start
<!-- AC:END -->
