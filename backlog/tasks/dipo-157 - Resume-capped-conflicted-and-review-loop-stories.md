---
id: DIPO-157
title: 'Resume capped, conflicted and review-loop stories'
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
  - DIPO-155
  - DIPO-219
  - DIPO-149
  - DIPO-150
  - DIPO-151
  - DIPO-205
  - DIPO-284
  - DIPO-289
  - DIPO-290
  - DIPO-291
  - DIPO-292
  - DIPO-294
references:
  - packages/engine/src/run/
  - packages/engine/src/merge-slot/
  - packages/engine/src/story-pr/
  - packages/engine/test/run/
  - packages/engine/test/merge-slot/
priority: high
type: feature
ordinal: 146000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: resuming verify-failing (loops, ci), conflict (merge in progress, unwritable path, push rejected, slot refused), review-blocked, stopped with causes pr-closed and review, and worker-failed with causes review and review-cap follows the ADR 0020 matrix, each noted resume adding one round as a grant.

Context: implements the cap, conflict and review-loop rows of the ADR 0020 section 2 matrix and its rule that every resume with a note adds exactly one round of the limit that fired (spike answer 6b), for the parks 0019 causes (0019 sections 4, 8, 9 and 10).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). A resume that finds its place taken is queued (Resumption returns queued: true and a run.queued notice), but the work.answer reply does not say so yet; the resume replies of this story say when a resume was queued. The review-resume starter registers for the reviewer place.

DIPO-205 adds the park verify-failing with cause capped: a run whose cap-crossing turn carried a done report took the done path, and its verify failed with no turn left. Its resume (0020 Amendments, 2026-10-19, DIPO-205) needs a note, like the loops and ci causes, and grants the section 4 top-up: all three caps grow by 50% of the starting caps as one budget grant recorded with who and why. Writing the note is the explicit act, so no further confirmation is asked; the reply names the grant. The first message is the verify failure from the park detail (nothing stores it in feedback_items, since no feedback turn was sent), then the note; without a note it answers resume.noteRequired.

```dipo
branch: "DIPO-157/resume-review-loop-and-cap-parks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) loops, ci, conflictHandoff and reviewRound resumes each record exactly one grant and send the stored item first"
    - kind: "automated"
      check: "(integration, real git) a merge-in-progress resume continues the kept merge, and after a base move aborts and merges again"
    - kind: "automated"
      check: "(unit) slot-refused re-enters the slot without a session and pr-closed opens a new PR naming the old one"
    - kind: "automated"
      check: "(unit) a review-cap resume grows the reviewer cap by 50% as a grant"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 verify-failing/loops and verify-failing/ci resume with a required note, the first message being the last verify or CI item from feedback_items, and record one loop or ciAttempt grant
- [ ] #2 conflict/merge-in-progress continues the kept merge with its conflict item when the base has not moved and aborts and merges again when it moved, recording one conflictHandoff grant; conflict/unwritable-path merges the base again and parks at once if an unwritable path still conflicts
- [ ] #3 conflict/push-rejected fetches the remote branch and merges it into the local branch through the 0019 hand-off, never by force, and the worker gets the commits that were only on the remote; conflict/slot-refused returns to In Review and re-enters the merge slot with a fresh per-stay count and no model session
- [ ] #4 review-blocked/rounds with a note returns to In Review and then In Progress as a fix round with the blocking findings first, recording one reviewRound grant
- [ ] #5 stopped/pr-closed returns to In Review and opens a new story PR for the same head whose body names the closed one; stopped/review and worker-failed/review start a fresh reviewer session of the same round on the same head; worker-failed/review-cap does the same and grows the cap that fired by 50% as a reviewCap grant
- [ ] #6 No resume raises a cap without a recorded grant, shown by a test that checks every cap change against a grant row
- [ ] #7 verify-failing/capped (DIPO-205) resumes only with a note, grows all three caps by 50% of the starting caps as one budget grant recorded with who and why, with no confirmation beyond the note, and starts with the verify failure from the park detail, then the note; a resume without a note answers resume.noteRequired
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: park and resume keep the story's box (0021 section 6).

From the first box run (DIPO-275 on DIPO-248, 2026-10-22): a dipo steer sent to a story that then parks as verify-failing (loops) is held, and the park offers only story.drop, so the steer waits for this story's resume. The steer reply should also say when the park has no resume yet.

From DIPO-299 (2026-10-22): a box run whose branch tip moved at done now parks interrupted with cause build, not verify-failing with cause refused.
<!-- SECTION:NOTES:END -->
