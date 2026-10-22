---
id: DIPO-256
title: >-
  Show the worker its remaining budget, wrap up at 80% of a cap, and raise the
  tier caps
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-255
  - DIPO-285
  - DIPO-293
  - DIPO-294
  - DIPO-299
references:
  - packages/engine/src/config/schema.ts
  - packages/engine/test/config/
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/prompts/handoff.ts
  - packages/engine/src/prompts/task/
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/test/prompts/
  - packages/engine/test/workers/golden/
priority: high
type: enhancement
ordinal: 136450
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every feedback message and every handoff tells the worker its turns, minutes and tokens used and left; the contract asks it to stop new work at about 80% of any cap, finish and report done or blocked with what is left; and the tier default caps are raised to S 90 turns and 45 minutes, M 200 and 90, L 300 and 180, with token budgets unchanged.

Context: the maintainer's decision D4 of 2026-10-20 (answer A, and raise the caps); dated 0020 note (budget line and wrap-up) and 0008 section 9 note (caps) of 2026-10-20. Observed in the M1 runs: S used 26 turns on average (two capped at 64 and 65), M 65 on average (max 185), L 134 (max 173); no run hit its token budget (docs/research/2026-10-20-dipo-run-gaps.md section 1). The tier defaults are in packages/engine/src/config/schema.ts (S budgetTokens 300,000, maxTurns 60, maxMinutes 30; M 800,000, 120, 60; L 2,000,000, 200, 120); the review caps of the same file (60 turns, 30 minutes) are not changed. A run keeps the caps of its start snapshot plus grants (0020 section 5), so the raise applies to runs started after it. Feedback items are built in packages/engine/src/prompts/feedback.ts (templates in packages/engine/src/prompts/feedback/, including nudge-budget.md), the handoff in packages/engine/src/prompts/handoff.ts, and the run's prompt inputs in packages/engine/src/run/prompts.ts; verify feedback is sent from packages/engine/src/run/verify-commit.ts and CI feedback is built by ciFeedback (DIPO-147). Review and reject feedback do not exist yet: DIPO-148 and DIPO-151 append the same budget line to the messages they add. The budget numbers come from the run's start snapshot caps plus its grants (design choice, not a maintainer decision; the maintainer may change it before a run).

```dipo
branch: "DIPO-256/budget-line-and-caps"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) config tests: the tier defaults are S 300,000 tokens, 90 turns, 45 minutes; M 800,000, 200, 90; L 2,000,000, 300, 180; the review caps stay 60 and 30"
    - kind: "automated"
      check: "(unit) a verify feedback message, a CI feedback message and a handoff each end with one budget line naming turns, minutes and tokens used and left"
    - kind: "automated"
      check: "(golden) the contract golden has the wrap-up rule at about 80% of any cap"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The tier defaults in packages/engine/src/config/schema.ts are S 90 turns and 45 minutes, M 200 turns and 90 minutes, L 300 turns and 180 minutes, with budgetTokens unchanged (300,000, 800,000 and 2,000,000), and the review caps unchanged
- [ ] #2 Every verify feedback message, every CI feedback message (ciFeedback) and every handoff message ends with one budget line that names turns, minutes and tokens used and left, computed from the run's start snapshot caps plus its grants; the review and reject feedback of DIPO-148 and DIPO-151 append the same line when they are built
- [ ] #3 The worker contract in packages/engine/src/prompts/contract/implement.md says, with tool-neutral wording, that at about 80% of any cap the worker stops new work, finishes what it started and reports done, or blocked with what is left; its golden is updated
- [ ] #4 Tests cover the new defaults, the budget line in each message kind and the contract text
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-22: dropped the dependency on DIPO-149 (which now holds DIPO-291) to break a dependency cycle left by the M1 combine; that story now comes after this one.
<!-- SECTION:NOTES:END -->
