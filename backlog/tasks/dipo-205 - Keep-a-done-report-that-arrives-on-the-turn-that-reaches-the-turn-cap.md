---
id: DIPO-205
title: Keep a done report that arrives on the turn that reaches the turn cap
status: Refined
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-18 14:32'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/caps.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/test/run/
priority: medium
type: bug
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the turn that reaches a run's turn cap also carries the worker's done report, the maintainer's chosen rule decides what happens, so finished work is not left uncommitted in a budget-exceeded park.

Context: M1a run of DIPO-188 on 2026-10-18 (run_01M57FV2GAP0660HZ1S185XRDB, tier S, turn cap 60). The worker finished its work, ran verify and reported done, but the session crossed the cap at turn 63 while it did, so dipo parked the story budget-exceeded ("turn cap reached: 63 of 60 turns") and committed nothing. The maintainer side copied the uncommitted diff onto a finish branch by hand. In RunControl (packages/engine/src/run/control.ts) a turn event with `capped` goes to #cap and returns before the turn's report is read; caps.ts builds the detail. 0020 decision 1 and the budget-exceeded row of section 2 resume such a park only with a top-up (`--budget` and `--note`), so a change to what a capped turn's report means is a dated 0020 note the maintainer approves; this story does not edit docs/decisions/. DIPO-105 parked the same way (0020 context) with work that was not finished.

```dipo
branch: "DIPO-205/done-report-at-turn-cap"
unknowns:
  - q: "When the turn that reaches the turn cap carries a done report, should dipo (A) treat the run as done and run its normal done path (verify-commit, In Review), with the cap noted in the outcome, (B) still park budget-exceeded but commit the work to the branch first so a resume or a hand finish starts from it, or (C) keep today's park unchanged and only raise the tier S turn cap in the office defaults?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a run whose turn crosses maxTurns with a done report follows the chosen rule, and a capped turn without a report still parks budget-exceeded"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A run whose capping turn carries a done report follows the rule the maintainer chose for the unknown, with a test in packages/engine/test/run/ that drives RunControl with such a turn
- [ ] #2 A capped turn without a done report still parks budget-exceeded with the turn cap detail, and its test passes unchanged
<!-- AC:END -->
