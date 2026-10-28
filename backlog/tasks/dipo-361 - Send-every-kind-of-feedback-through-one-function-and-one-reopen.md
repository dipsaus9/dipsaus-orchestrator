---
id: DIPO-361
title: Send every kind of feedback through one function and one reopen
status: Done
assignee: []
created_date: '2026-10-28 08:45'
updated_date: '2026-10-28 10:31'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-345
references:
  - packages/engine/src/run/
  - packages/engine/src/review/
  - packages/engine/src/prompts/
  - packages/engine/src/workers/
  - docs/decisions/0002-review-and-testing.md
priority: high
type: feature
ordinal: 341000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the report gate, a red verify, a conflict, a blocked review, red checks, a reject, a resume note and a steer reach the developer session through one function with a source tag and one reopen, and a bad done report parks as its kind says.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-345 (its criterion 1), which fixed the caps. 0002 (one feedback path), 0020 (resume, steer), 0008 (the report). Maintainer decision of 2026-10-28: a report that does not parse or does not match the schema is a broken worker (0008), a valid report that misses coverage is report gate feedback (0002).

```dipo
branch: "DIPO-361/one-feedback-function"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every feedback source arrives as one message to the same box session through the one function"
    - kind: "automated"
      check: "(engine) an unparsable report gets one correction turn and then parks worker-failed, and an uncovered test-plan entry parks verify-failing at the loop cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One function, sendFeedback, sends the report gate, the conflict at done, overlap and catch-up messages, the report correction, steers, held answers and the resume note to the developer session with a source tag, and reopenForRound, reopenParkedRun and reopenRun become one reopen; every helper they replace is removed (the fix-round message and the park-resume first message moved to DIPO-362)
- [x] #2 A done report that does not parse or does not match the schema gets one correction turn and then parks worker-failed; a valid report that misses test-plan coverage or still has conflict markers is report gate feedback against the tier loops and parks verify-failing at the cap; no bad report parks ambiguous-spec
- [x] #3 0002's report gate list no longer names schema validity, and 0002 and 0008 say the same, with one line in 0002's Replaced list
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
sendFeedback (run/feedback.ts) is the one function for the report gate, the conflict at done, overlap and catch-up messages, the report correction, steers, held answers and the resume note, each with a source tag; a row records whether it was sent live or held for the next session, so a crash never replays a live message. reopenForRound, reopenParkedRun and reopenRun are one reopen. A report that does not parse or match the schema gets one correction turn and then parks worker-failed; conflict markers and test-plan misses are report gate feedback against the tier loops and park verify-failing at the cap (budget-exceeded on a capped turn); no bad report parks ambiguous-spec. Migration 0061 rewrites stored intents through their templates, so prompt tags stay neutralised. 0002 and 0008 now agree, with one Replaced line. The fix-round and park-resume messages moved to DIPO-362.
<!-- SECTION:FINAL_SUMMARY:END -->
