---
id: DIPO-239
title: Start no review round for a run whose story is Done on the base
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:35'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
references:
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/places.ts
  - packages/engine/test/run/reviews.test.ts
priority: high
type: bug
ordinal: 239000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the reviewer place never starts or reopens a review for a run whose story the index reads as Done on the office base, so a story finished through another branch gets no paid review session after it merged.

Context: live on 2026-10-20 after the temp daemon was rebuilt with DIPO-219. Each time a place freed, the places drain took the next pending review (pendingReviews in packages/engine/src/run/review-rounds.ts: a story run ended In Review, with a review round cap and a live claim) and reopened it with reopenForRound into review round 1 with a 200k allowance. DIPO-237, 229, 227, 195 and 136 were reopened in turn, each already reviewed and merged on main through a -finish branch; the maintainer chose to stop them (dipo stop) and file this. DIPO-237's run had been left waiting=review, never ended, by the binary before review rounds; pendingReviews does not see such a run, but waitingStarts in packages/engine/src/run/places.ts starts it when a place frees. Reconcile's done-on-base release (packages/engine/src/reconcile/done-on-base.ts, DIPO-216) releases such a claim only when its worktree can be removed; a kept claim (dirty or foreign-locked worktree) stays live, so the run stays pending. lifecycleOf (packages/engine/src/views/story.ts) reads Done from the index.

```dipo
branch: "DIPO-239/no-review-when-done-on-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run ended In Review with a live claim whose story the index reads as Done is not in pendingReviews and no review round starts when a place frees"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run waiting for the reviewer place whose story turned Done ends with its waiting cleared and one info log line naming the run and the story, and no session starts"
    - kind: "automated"
      check: "(unit) reviews.test.ts: a run ended In Review whose story is In Review on the base still gets its review round as before"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pendingReviews in packages/engine/src/run/review-rounds.ts leaves out a run whose story the office index reads as Done on the base, so the places drain never reopens it for a review
- [ ] #2 When a run waiting for the reviewer place (a reopened review, or a run left waiting=review) is about to start and its story is Done on the base, the start does not happen: the run ends with its waiting cleared and an info line in the log naming the run and the story, and no worker host or session starts
- [ ] #3 A run ended In Review whose story is not Done on the base keeps today's behaviour: it is pending and its review round starts when the reviewer place frees
- [ ] #4 Tests in packages/engine/test/run/reviews.test.ts cover the three cases before with a fake index
<!-- AC:END -->
