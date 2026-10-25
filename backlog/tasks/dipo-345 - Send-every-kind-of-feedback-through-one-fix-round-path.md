---
id: DIPO-345
title: Send every kind of feedback through one fix-round path
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-344
references:
  - packages/engine/src/run/
  - packages/engine/src/review/
  - packages/engine/src/prompts/
  - packages/engine/src/db/
  - packages/contract/src/
priority: high
type: feature
ordinal: 325000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the report gate, a red verify, a conflict, a blocked review, red checks, a reject, a resume note and a steer reach the worker through one function and one reopen, caps are fixed at run start with only budget and round grants, and the reviewer has a budget of its own.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. 0002 section 5 and 0020 section 3. Absorbs DIPO-319 (one function decides a run's transitions).

```dipo
branch: "DIPO-345/one-feedback-path"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) every feedback source arrives as one message to the same box session and counts against its own cap"
    - kind: "automated"
      check: "(unit) the transition function covers every state and event pair of a run"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One function sends feedback of every source to the developer session with a source tag, and reopenForRound and reopenParkedRun become one reopen
- [ ] #2 One pure function decides the next state of a run from its state and an event, and each run table has one writer
- [ ] #3 The caps of a run are fixed at its start, a cap grows only by a budget or a round grant recorded with the note, and the per-round review allowance and the implicit +50% are removed
- [ ] #4 The reviewer's turns, minutes and tokens count against the reviewer's own caps and never against the story's budget
- [ ] #5 Each source has one cap as in the 0002 table, and reaching it parks the story with that table's reason
<!-- AC:END -->
