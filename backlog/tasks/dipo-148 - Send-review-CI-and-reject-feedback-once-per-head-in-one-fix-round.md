---
id: DIPO-148
title: 'Send review and CI feedback once per head, with the reviewer''s caps'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 19:26'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
  - cutover
milestone: m-1
dependencies:
  - DIPO-147
  - DIPO-205
  - DIPO-219
  - DIPO-186
  - DIPO-240
  - DIPO-284
  - DIPO-290
  - DIPO-292
  - DIPO-293
  - DIPO-294
  - DIPO-295
  - DIPO-299
  - DIPO-152
  - DIPO-296
  - DIPO-183
references:
  - packages/daemon/src/runs.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/prompts/
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/rounds.ts
  - packages/engine/src/story-pr/
  - packages/engine/test/db/
  - packages/engine/test/run/
  - packages/engine/test/run/reviews.test.ts
  - packages/engine/test/story-pr/
priority: high
type: feature
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: feedback items with their text are stored in feedback_items, sent once per head with repeats marked, and batched into one fix round that resumes the developer session in the worker place; the reviewer place starts no review round for a run whose story is Done on the office base; and a reviewer session keeps the caps of its run's start snapshot, while a refused reviewer launch plan raises an office notice.

Context: implements ADR 0019 section 8 (sources, one round per head, items and signatures, storage, send-once, caps per source) and the fix-round timing of section 7. Verify items already carry a sha256 signature, but nothing records which were sent (0019 fact 10).

The worker place and the reviewer place are in packages/engine/src/run/places.ts; packages/engine/src/run/compose.ts wires the resume and review starters (DIPO-219) and START_KINDS already has fix, and packages/engine/src/run/rounds.ts has RoundKind fix and reopenForRound. The fix round registers the fix starter in the worker place. work.run's place check and the direct park resume both run through Places.serialized (DIPO-208, DIPO-229), so a fix round that drains into the worker place does not race a pickup. The CI items of a red head come from the story PR poll: StoryPrs.ciItems and the checks-final handling in packages/engine/src/story-pr/prs.ts (DIPO-147); review items come from the review rounds (DIPO-219). The fix round appends no run_steps kind of its own: DIPO-147 appends the ci step, one per red pushed head, which is the count it parks on at the run's CI cap, and DIPO-219 appends review-failed for a blocked round; the final run_outcomes row counts both. Places.drain runs the pre-start cap check (#parkedForCaps, DIPO-205) before it calls a starter, so the feedback rows and the intent are written when the fix round is queued. A maintainer reject has no engine handler yet: gate.reject is DIPO-151, which depends on this story and feeds it the reject item.

From DIPO-239: live on 2026-10-20 after the temp daemon was rebuilt with DIPO-219. Each time a place freed, the places drain took the next pending review (pendingReviews in packages/engine/src/run/review-rounds.ts: a story run ended In Review, with a review round cap and a live claim) or a run left waiting for the reviewer place, and Reviews.start (packages/engine/src/run/reviews.ts) reopened it with reopenForRound into review round 1 with a 200k allowance. DIPO-237, 229, 227, 195 and 136 were reopened in turn, each already reviewed and merged on main through a -finish branch; the maintainer chose to stop them (dipo stop) and file this. DIPO-237's run had been left waiting=review, never ended, by a binary from before review rounds. The office index cannot answer "Done on the base" for these runs: for a live claim with a claim commit the index (backlog_mirror, through overlayClaimed in packages/engine/src/stories/index-stories.ts) holds the branch's read, so storyView and lifecycleOf give In Review, and the base status lives only in one pass's IndexResult.baseStatus. Reviews.start already reads the story on the office base before it reopens anything: deps.story is baseStoryFacts, and facts.view is the base's plain task. It also already returns early for a run whose end kind is done (DONE_END in packages/engine/src/run/records.ts), and endReviewPeriod (packages/engine/src/run/rounds.ts) ends an open review period with a given end kind. The claim is left to reconcile's done-on-base release (packages/engine/src/reconcile/done-on-base.ts, DIPO-216), which releases it once the worktree can be removed.

From DIPO-247: advisories of the DIPO-219 review (PR #267). reviewerSettings in packages/engine/src/run/review-launch.ts takes maxTurns and maxMinutes from runCaps of the run's snapshot and, when the snapshot has none (`reviewMaxTurns ?? config.review.maxTurns`), from the office config in force; 0020 section 5 has a run keep the caps of its start snapshot, so a config change after the start changes a review's caps. ReviewLauncher.start turns a PlanError from worker.prepare into `{ kind: "failed", reason }`, which only warns; the worker launch path (packages/engine/src/run/launch.ts) raises the run.planRefused engine.notice with planRefusedText naming the path and the character. packages/engine/test/run/reviews.test.ts has no test for a reviewer whose worker host is lost or for the reviewer minute cap.

```dipo
branch: "DIPO-148/review-ci-feedback"
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
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run ended In Review whose story the base read gives as Done: Reviews.start returns false, reopens nothing, starts no session, sets the end kind to done and writes one review.doneOnBase info notice naming the story; a second start for the same run does nothing"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run waiting for the reviewer place (ended_at null) whose story the base read gives as Done ends with end kind done, its waiting cleared and its place free, and no session starts"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run whose story is In Review on the base still gets its review round and session as before, and the claim stays live in every case"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run whose snapshot has review caps keeps them after the office config's review caps change; a run whose snapshot has none gets the caps written into its snapshot at the first review start and keeps them"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a PlanError at reviewer launch raises one run.planRefused notice with planRefusedText"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a reviewer whose host is lost and a reviewer past its minute cap each end the round as the code sets, with the review-failed step and the story's lifecycle checked"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A feedback_items table (run, item id, source, signature, head commit, round, sent time, the carrying intent, rendered text of at most 3,000 characters; retention tier S) is written in the same transaction as the steer intent that sends the items
- [ ] #2 Review items carry the section 8 evidence and signature (criterion number and status; or kind, file and the whitespace-collapsed quote; or kind and test-plan entry number), and a maintainer reject item has its stored shape (the note verbatim, keyed on the gate id) and the same send path, built from what DIPO-151's gate.reject records; until DIPO-151 exists no reject item is produced
- [ ] #3 An item is sent at most once per head commit across polls and daemon restarts; the same signature on a later head is sent again marked still failing after your last change, and two sends in a row of one verify or CI signature raise the same-failure watchdog signal
- [ ] #4 All feedback for one head goes in one user message; the fix round waits until that head's verdict is in and its required checks are final or past the wait cap, reopens the run in the worker place, commits <ID>: status In Progress, and resumes the developer session when canResume holds, else starts a new session with a handoff; the fix round stores its feedback_items rows and its intent when it is queued, before the shared pre-start cap check that DIPO-205 adds, so a round that check parks keeps its feedback for a top-up resume (DIPO-156)
- [ ] #5 Advisory findings never start a fix round on their own and are listed as optional when a fix round starts for another reason
- [ ] #6 (from DIPO-239) In Reviews.start in packages/engine/src/run/reviews.ts, after the base read of the story (deps.story, baseStoryFacts) and before any reopenForRound or beginReviewRound, a story whose base status is Done gets no review round and no session, and start returns false
- [ ] #7 (from DIPO-239) Such a run ends with end kind done: a run ended at In Review has its end kind set to done in one write, and a run still open and waiting for the reviewer place ends through endReviewPeriod with end kind done, its waiting cleared and its place free; in both cases one info engine.notice review.doneOnBase names the story and the run, and the claim stays live for reconcile's done-on-base release
- [ ] #8 (from DIPO-239) A run whose story is not Done on the base keeps today's behaviour: its review round and session start when the reviewer place frees
- [ ] #9 (from DIPO-239) Tests in packages/engine/test/run/reviews.test.ts cover a run ended at In Review and a run waiting for the reviewer place, each with a base read giving Done, a second start for the same run, and a run whose story is In Review on the base
- [ ] #10 (from DIPO-247) reviewerSettings reads the reviewer's turn and minute caps only from the run's snapshot: a run whose snapshot has no review caps gets the office's current review caps written into its snapshot at its first review start, and later config changes do not change them
- [ ] #11 (from DIPO-247) A PlanError at reviewer launch raises the run.planRefused engine.notice on the office with planRefusedText, as the worker launch does, besides returning the failed start
- [ ] #12 (from DIPO-247) packages/engine/test/run/reviews.test.ts covers the snapshot caps after a config change, the planRefused notice, a reviewer whose worker host is lost and a reviewer past its minute cap
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: fix rounds go to the same builder in its kept box, including CI failures and the maintainer's PR comments until merge (0021 sections 6 and 10).

From DIPO-299 (2026-10-22): CI is the verify of a box run. Send a box run's red CI items (kept by StoryPrs as ciItems) to the same worker as the fix round, and read noCiRan() for the fix-round timing, so a head without CI is not waited on.

Carried from DIPO-247: Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: the reviewer has no box; its tools are read-only plus web (0021 section 10).

2026-10-22: combined from DIPO-239, DIPO-247 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-159 (which now holds DIPO-289) and DIPO-149 (which now holds DIPO-291) to break a dependency cycle left by the M1 combine; those stories now come after this one.
<!-- SECTION:NOTES:END -->
