---
id: DIPO-128
title: Split RunOutcomes and RunControl before M1 extends the run code
status: Ready
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-17 19:32'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-129
references:
  - packages/engine/src/run
  - packages/engine/test/run
  - packages/daemon/src/runs.ts
  - .oxlintrc.json
priority: medium
type: task
ordinal: 118000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run outcome and control code is split into units small enough that the M1 review-and-park stories can extend it without growing two very large classes further.

Context: RunOutcomes in packages/engine/src/run/outcomes.ts is about 1,300 lines with 35 methods and a #deciding guard added and removed at about 7 sites; RunControl in run/control.ts is about 900 lines (outcomes.ts is 1,730 lines and control.ts 1,147 on main at fe300b5). The intent helper (DIPO-126) and the single run wiring (DIPO-129) change the same code first. Later M1 stories that extend the run code must depend on this story. Found by the 2026-10-16 milestone review, section 1c CC3.

```dipo
branch: "DIPO-128/split-run-outcomes-and-control"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the existing run tests pass without changes to their assertions"
    - kind: "automated"
      check: "(ci) the CI-only run tests pass"
    - kind: "automated"
      check: "(unit) the #deciding guard exists once, as one shared helper with its own test"
    - kind: "automated"
      check: "(lint) no split file is over 600 lines, no class over 400, and the DIPO-127 lint exception lists, when merged, shrink by the split files and do not grow"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RunOutcomes and RunControl are split along their responsibilities (for example per outcome kind, the decision guard as one shared helper); no file split out of outcomes.ts or control.ts, nor what remains of them, is over 600 lines, and no class from them is over 400
- [ ] #2 Behaviour is unchanged: the existing run tests pass without changes to their assertions, and the CI-only run tests pass
- [ ] #3 The #deciding guard exists once
- [ ] #4 The lint exception lists of DIPO-127 (when merged) shrink by the split files and do not grow
<!-- AC:END -->
