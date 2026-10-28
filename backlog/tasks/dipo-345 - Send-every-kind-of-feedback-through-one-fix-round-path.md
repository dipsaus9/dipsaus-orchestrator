---
id: DIPO-345
title: Fix a run's caps at its start and give the reviewer caps of its own
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 08:49'
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
- [x] #1 The caps of a run are fixed at its start, a cap grows only by a budget or a round grant recorded with the note, and the per-round review allowance and the implicit +50% are removed
- [x] #2 The reviewer's turns, minutes and tokens count against the reviewer's own caps and never against the story's budget
- [x] #3 Each source has one cap as in the 0002 table, and reaching it parks the story with that table's reason
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A run's caps are fixed at its start and grow only by a recorded budget grant (the 0020 top-up, refused when too small) or a round grant that names its cap, with the note and the caps before and after (migration 0058). The per-round review allowance and the implicit +50% are removed. The reviewer has caps of its own (review.budgetTokens is its per-session token cap); its usage stays out of the story's totals, budget checks, usage view, final summary and run outcome, and any reviewer cap parks worker-failed. Report gate refusals write a loop step and park verify-failing at the tier loop cap, as the 0002 table says. ADR 0002 and 0020 reworded to match. One feedback function moved to DIPO-361, the transition function to DIPO-362.
<!-- SECTION:FINAL_SUMMARY:END -->
