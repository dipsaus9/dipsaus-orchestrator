---
id: DIPO-168
title: Prove waiting commands are safe to re-run
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-159
  - DIPO-160
  - DIPO-161
  - DIPO-163
references:
  - packages/engine/src/commands/
  - packages/engine/test/commands/
priority: high
type: task
ordinal: 157000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each waiting office command has a test that crashes between its commit and its request record and shows a retry repeats no effect.

Context: implements the 0005 note of 2026-10-17 recorded in ADR 0020 (Amends): every waiting handler must be target-state under a re-run, and each waiting command has a test that injects a crash between a commit and the requests row. Today four commands use the waiting path and 0005 does not describe it (0020 fact 8).

```dipo
branch: "DIPO-168/waiting-commands-rerun-tests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) one crash-and-retry test per waiting command asserting no repeated effect"
    - kind: "automated"
      check: "(unit) a duplicate request during a running handler gets the same reply"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For each waiting office command (work.run, work.stop, work.answer, work.resume, story.hold, story.drop, work.discard, work.steer, work.pause) a test injects a crash after a handler commit and before the requests row, then retries the command
- [ ] #2 Each retry repeats no effect: no second commit, push, PR close, message to the worker or grant
- [ ] #3 A duplicate request that arrives while the first one runs waits for the same reply, shown by a test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: combined into DIPO-155 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
