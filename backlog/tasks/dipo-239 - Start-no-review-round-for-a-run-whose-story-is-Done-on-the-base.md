---
id: DIPO-239
title: Start no review round for a run whose story is Done on the base
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 19:05'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-250
references:
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/rounds.ts
  - packages/engine/test/run/reviews.test.ts
priority: high
type: bug
ordinal: 239000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the reviewer place never starts a review round for a run whose story is Done on the office base: Reviews.start ends such a run as done instead, so a story finished through another branch gets no paid review session after it merged and is not offered for review again.

Context: live on 2026-10-20 after the temp daemon was rebuilt with DIPO-219. Each time a place freed, the places drain took the next pending review (pendingReviews in packages/engine/src/run/review-rounds.ts: a story run ended In Review, with a review round cap and a live claim) or a run left waiting for the reviewer place, and Reviews.start (packages/engine/src/run/reviews.ts) reopened it with reopenForRound into review round 1 with a 200k allowance. DIPO-237, 229, 227, 195 and 136 were reopened in turn, each already reviewed and merged on main through a -finish branch; the maintainer chose to stop them (dipo stop) and file this. DIPO-237's run had been left waiting=review, never ended, by a binary from before review rounds. The office index cannot answer "Done on the base" for these runs: for a live claim with a claim commit the index (backlog_mirror, through overlayClaimed in packages/engine/src/stories/index-stories.ts) holds the branch's read, so storyView and lifecycleOf give In Review, and the base status lives only in one pass's IndexResult.baseStatus. Reviews.start already reads the story on the office base before it reopens anything: deps.story is baseStoryFacts, and facts.view is the base's plain task. It also already returns early for a run whose end kind is done (DONE_END in packages/engine/src/run/records.ts), and endReviewPeriod (packages/engine/src/run/rounds.ts) ends an open review period with a given end kind. The claim is left to reconcile's done-on-base release (packages/engine/src/reconcile/done-on-base.ts, DIPO-216), which releases it once the worktree can be removed.

```dipo
branch: "DIPO-239/no-review-when-done-on-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run ended In Review whose story the base read gives as Done: Reviews.start returns false, reopens nothing, starts no session, sets the end kind to done and writes one review.doneOnBase info notice naming the story; a second start for the same run does nothing"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run waiting for the reviewer place (ended_at null) whose story the base read gives as Done ends with end kind done, its waiting cleared and its place free, and no session starts"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run whose story is In Review on the base still gets its review round and session as before, and the claim stays live in every case"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In Reviews.start in packages/engine/src/run/reviews.ts, after the base read of the story (deps.story, baseStoryFacts) and before any reopenForRound or beginReviewRound, a story whose base status is Done gets no review round and no session, and start returns false
- [ ] #2 Such a run ends with end kind done: a run ended at In Review has its end kind set to done in one write, and a run still open and waiting for the reviewer place ends through endReviewPeriod with end kind done, its waiting cleared and its place free; in both cases one info engine.notice review.doneOnBase names the story and the run, and the claim stays live for reconcile's done-on-base release
- [ ] #3 A run whose story is not Done on the base keeps today's behaviour: its review round and session start when the reviewer place frees
- [ ] #4 Tests in packages/engine/test/run/reviews.test.ts cover a run ended at In Review and a run waiting for the reviewer place, each with a base read giving Done, a second start for the same run, and a run whose story is In Review on the base
<!-- AC:END -->
