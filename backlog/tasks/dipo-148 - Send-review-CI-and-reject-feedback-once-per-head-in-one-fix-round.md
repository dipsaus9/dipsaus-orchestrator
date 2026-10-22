---
id: DIPO-148
title: 'Send review, CI and reject feedback once per head in one fix round'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 11:31'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-147
  - DIPO-205
  - DIPO-219
  - DIPO-259
  - DIPO-239
  - DIPO-240
  - DIPO-284
  - DIPO-289
  - DIPO-290
  - DIPO-291
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-295
  - DIPO-299
references:
  - packages/engine/src/run/
  - packages/engine/src/prompts/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/test/run/
  - packages/engine/test/db/
  - packages/engine/src/story-pr/
  - packages/engine/test/story-pr/
  - packages/daemon/src/runs.ts
priority: high
type: feature
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: feedback items with their text are stored in feedback_items, sent once per head with repeats marked, and batched into one fix round that moves the story to In Progress and resumes the developer session in the worker place.

Context: implements ADR 0019 section 8 (sources, one round per head, items and signatures, storage, send-once, caps per source) and the fix-round timing of section 7. Verify items already carry a sha256 signature, but nothing records which were sent (0019 fact 10).

The worker place and the reviewer place are in packages/engine/src/run/places.ts; packages/engine/src/run/compose.ts wires the resume and review starters (DIPO-219) and START_KINDS already has fix, and packages/engine/src/run/rounds.ts has RoundKind fix and reopenForRound. The fix round registers the fix starter in the worker place. work.run's place check and the direct park resume both run through Places.serialized (DIPO-208, DIPO-229), so a fix round that drains into the worker place does not race a pickup. The CI items of a red head come from the story PR poll: StoryPrs.ciItems and the checks-final handling in packages/engine/src/story-pr/prs.ts (DIPO-147); review items come from the review rounds (DIPO-219). The fix round appends no run_steps kind of its own: DIPO-147 appends the ci step, one per red pushed head, which is the count it parks on at the run's CI cap, and DIPO-219 appends review-failed for a blocked round; the final run_outcomes row counts both. Places.drain runs the pre-start cap check (#parkedForCaps, DIPO-205) before it calls a starter, so the feedback rows and the intent are written when the fix round is queued. A maintainer reject has no engine handler yet: gate.reject is DIPO-151, which depends on this story and feeds it the reject item.

```dipo
branch: "DIPO-148/send-feedback-once-per-head"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a fix round whose run's caps are reached stores its feedback_items rows first, then the DIPO-205 pre-start cap check parks it budget-exceeded, and the rows stay with no delivered intent"
    - kind: "automated"
      check: "(unit) an item for one head is sent once across a simulated daemon restart, and the same signature on a new head is marked as a repeat"
    - kind: "automated"
      check: "(unit) a fix round waits for both the verdict and final checks of its head and sends one message"
    - kind: "automated"
      check: "(unit) review item signatures ignore free text and collapse whitespace in quotes"
    - kind: "automated"
      check: "(migration) feedback_items exists with retention tier S"
    - kind: "automated"
      check: "(unit) a reject item has the stored shape (the note verbatim, keyed on the gate id) and goes out through the same send path as review and CI items; before DIPO-151 no reject item is produced"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A feedback_items table (run, item id, source, signature, head commit, round, sent time, the carrying intent, rendered text of at most 3,000 characters; retention tier S) is written in the same transaction as the steer intent that sends the items
- [ ] #2 Review items carry the section 8 evidence and signature (criterion number and status; or kind, file and the whitespace-collapsed quote; or kind and test-plan entry number), and a maintainer reject item has its stored shape (the note verbatim, keyed on the gate id) and the same send path, built from what DIPO-151's gate.reject records; until DIPO-151 exists no reject item is produced
- [ ] #3 An item is sent at most once per head commit across polls and daemon restarts; the same signature on a later head is sent again marked still failing after your last change, and two sends in a row of one verify or CI signature raise the same-failure watchdog signal
- [ ] #4 All feedback for one head goes in one user message; the fix round waits until that head's verdict is in and its required checks are final or past the wait cap, reopens the run in the worker place, commits <ID>: status In Progress, and resumes the developer session when canResume holds, else starts a new session with a handoff; the fix round stores its feedback_items rows and its intent when it is queued, before the shared pre-start cap check that DIPO-205 adds, so a round that check parks keeps its feedback for a top-up resume (DIPO-156)
- [ ] #5 Advisory findings never start a fix round on their own and are listed as optional when a fix round starts for another reason
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: fix rounds go to the same builder in its kept box, including CI failures and the maintainer's PR comments until merge (0021 sections 6 and 10).

From DIPO-299 (2026-10-22): CI is the verify of a box run. Send a box run's red CI items (kept by StoryPrs as ciItems) to the same worker as the fix round, and read noCiRan() for the fix-round timing, so a head without CI is not waited on.
<!-- SECTION:NOTES:END -->
