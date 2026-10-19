---
id: DIPO-219
title: >-
  Start pending reviews and run review rounds with their allowance, caps and
  failures
status: Refined
assignee: []
created_date: '2026-10-19 21:06'
updated_date: '2026-10-19 21:07'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-146
references:
  - packages/engine/src/run/
  - packages/engine/src/review/
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/test/run/
  - packages/engine/test/review/
  - packages/engine/test/prompts/
priority: high
type: feature
ordinal: 135500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story that reaches In Review gets its review through the pending-review starter in the reviewer place, a code tree key that already has a verdict is never reviewed again, each started round grows the run's budget by the review allowance, the third failed round parks review-blocked, and reviewer failures follow the ADR 0019 section 4 table.

Context: implements ADR 0019 section 6 (review rounds, the cap on failed rounds, no review of a code tree key that already has a verdict) and the allowance and failure table of section 4, on the report validation, verdicts and run-start caps of DIPO-146. The carry-over of an approval across a clean base merge the engine made (0019 section 6, second skip rule) belongs to DIPO-149 and DIPO-150, which record their own merges.

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). This story registers the pending-review starter: the review starter (START_KINDS.review) for the reviewer place, fed through PlacesDeps.pending, which places.ts documents as 0019 story G. A waiting start whose kind has no starter blocks its place, so the starter and the pending reviews land together. 0019 section 12 orders pending reviews by oldest In Review, so the order needs only the wait time (a pending start's since, or runs.waiting_since) to equal the In Review time. reopenForRound (packages/engine/src/run/rounds.ts) uses its at for the reopen, the review phase step and waiting_since alike, so passing the In Review time as at would also back-date the reopen and the phase step; pass the wait time separately. A failed review round appends the review-failed run_steps kind that the final run_outcomes row counts. The review-resume starter (a maintainer resume that starts a fresh review, 0020 section 2) belongs to DIPO-157.

```dipo
branch: "DIPO-219/start-reviews-and-run-review-rounds"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a story that reaches In Review gets a pending review that the review starter starts once the reviewer place is free, oldest In Review first by its wait time, while the reopen and its review phase step keep their own time, and the round's report is validated and its verdict stored by code tree key"
    - kind: "automated"
      check: "(unit) a code tree key with a verdict is not reviewed again after a simulated daemon restart, and a commit that changes only the story's task file takes the verdict without a round"
    - kind: "automated"
      check: "(unit) each started review round writes a review run_steps row and grows the run's budget limit by review_allowance, and a retried session of the same round adds nothing"
    - kind: "automated"
      check: "(unit) each row of the section 4 failure table, including the third failed round parking review-blocked with cause rounds and a review-failed run_steps row per failed round"
    - kind: "automated"
      check: "(unit) the correction turn for unverified evidence names the findings, golden-tested in packages/engine/test/prompts/"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The review starter (START_KINDS.review) is registered for the reviewer place in packages/engine/src/run/compose.ts and fed through PlacesDeps.pending, so a story that reaches In Review gets a pending review that starts a reviewer session when the reviewer place is free, oldest In Review first, with its wait time equal to the In Review time while the reopen and its review phase step keep their own time; the report of each round goes through DIPO-146's validation and its verdict is stored by code tree key
- [ ] #2 No review starts for a code tree key that already has a verdict in the claim, across a daemon restart; a head whose code tree key has a verdict (commits that change only the story's task file) takes that verdict without a round
- [ ] #3 Each review round started writes a run_steps review step and grows the run's budget limit by review_allowance; a retried session of the same round adds nothing
- [ ] #4 The third failed round parks review-blocked with cause rounds and the blocking findings as detail, and each failed round appends a review-failed run_steps row; reviewer failures follow the section 4 table, with causes review, review-cap and backstop and one correction turn for an invalid report or unverified evidence, the latter naming the findings from a template in packages/engine/src/prompts/feedback/
<!-- AC:END -->
