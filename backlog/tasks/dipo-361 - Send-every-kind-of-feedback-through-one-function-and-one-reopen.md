---
id: DIPO-361
title: Send every kind of feedback through one function and one reopen
status: Refined
assignee: []
created_date: '2026-10-28 08:45'
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
- [ ] #1 One function sends feedback of every source to the developer session with a source tag, and reopenForRound and reopenParkedRun become one reopen; every helper they replace is removed
- [ ] #2 A done report that does not parse or does not match the schema gets one correction turn and then parks worker-failed; a valid report that misses test-plan coverage or still has conflict markers is report gate feedback against the tier loops and parks verify-failing at the cap; no bad report parks ambiguous-spec
- [ ] #3 0002's report gate list no longer names schema validity, and 0002 and 0008 say the same, with one line in 0002's Replaced list
<!-- AC:END -->
