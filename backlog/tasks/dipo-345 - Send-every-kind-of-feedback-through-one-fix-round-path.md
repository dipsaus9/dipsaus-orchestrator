---
id: DIPO-345
title: Fix a run's caps at its start and give the reviewer caps of its own
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 08:45'
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
Outcome: caps are fixed at run start with only budget and round grants, each feedback source has one cap, and the reviewer has a budget of its own.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. 0002 section 5 and 0020 section 3. One feedback function and one reopen moved to DIPO-361, one transition function (from DIPO-319) to DIPO-362.

```dipo
branch: "DIPO-345/one-feedback-path"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) each feedback source counts against its own cap, and the reviewer's usage counts only against the reviewer's caps"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The caps of a run are fixed at its start, a cap grows only by a budget or a round grant recorded with the note, and the per-round review allowance and the implicit +50% are removed
- [ ] #2 The reviewer's turns, minutes and tokens count against the reviewer's own caps and never against the story's budget
- [ ] #3 Each source has one cap as in the 0002 table, and reaching it parks the story with that table's reason
<!-- AC:END -->
