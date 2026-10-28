---
id: DIPO-362
title: >-
  Send the remaining run messages through sendFeedback and keep an unfinished
  resume pending
status: Done
assignee: []
created_date: '2026-10-28 08:45'
updated_date: '2026-10-28 12:36'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-361
references:
  - packages/engine/src/run/
  - packages/engine/src/db/
priority: high
type: feature
ordinal: 342000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the fix-round message, the park-resume first message and the red-verify feedback go through sendFeedback, and a resume that throws after its lift stays pending instead of stranding the story.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-345 (its criterion 2), which absorbed DIPO-319 (read backlog/archive/tasks/ for its findings; its claims part was done by DIPO-348).

```dipo
branch: "DIPO-362/run-transitions-one-function"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every fix-round, resume and red-verify message arrives through sendFeedback, findings before the maintainer's words"
    - kind: "automated"
      check: "(engine) a resume that throws after its lift stays pending with a notice and the next recovery finishes it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A resume whose finishing step throws after the lift reached the branch leaves its intent pending with a notice instead of failing it, so a rescan cannot close the park row and strand the story In Progress (park-resume.ts recover; from the review of DIPO-360)
- [x] #2 The fix-round message (review, CI, reject, conflict while In Review), the park-resume first message and DIPO-346's red-verify feedback go through sendFeedback, findings before the maintainer's note; the fix-round intent, deliverFixRound, pendingFixRound, detail.fix and the message, note and held fields of the next-session request are removed (from DIPO-361)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The fix-round message, a resumed park's reason part and note, the conflict-resume message and the red-verify feedback go through sendFeedback, held for the next session and delivered in the transaction that records its agent; findings come before the maintainer's words (resume, steer, answer). The fix-round intent, pendingFixRound, deliverFixRound, ResumeIntent.fix and the next-session request's message, note, held and inRecord fields are removed; migration 0063 rewrites stored intents through the templates without duplicating findings. A resume that throws after its lift reached the branch stays pending with a park.resumeUnfinished notice, on the command path and in recover; the desk says a restart retries it and offers drop or discard. The transition function and one writer per table moved to DIPO-364.
<!-- SECTION:FINAL_SUMMARY:END -->
