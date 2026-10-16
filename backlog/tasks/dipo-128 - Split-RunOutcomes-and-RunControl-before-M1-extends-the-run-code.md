---
id: DIPO-128
title: Split RunOutcomes and RunControl before M1 extends the run code
status: To Do
assignee: []
created_date: '2026-10-16 13:06'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-123
  - DIPO-126
references:
  - packages/engine/src/run
  - packages/engine/test/run
  - packages/daemon/src/runs.ts
priority: medium
type: task
ordinal: 118000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the run outcome and control code is split into units small enough that the M1 review-and-park stories can extend it without growing two very large classes further.

Context: RunOutcomes in packages/engine/src/run/outcomes.ts is about 1,300 lines with 35 methods and a #deciding guard copied about 7 times; RunControl in run/control.ts is about 880 lines (outcomes.ts is 1,730 lines and control.ts 1,147 on main at fe300b5). DIPO-123 and the intent helper story change the same code, so this follows them. M1 review-and-park stories that extend the run code depend on this story. Found by the 2026-10-16 milestone review, section 1c CC3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RunOutcomes and RunControl are split along their responsibilities (for example per outcome kind, the decision guard as one shared helper), with no file over about 600 lines and no class over about 400
- [ ] #2 Behaviour is unchanged: the existing run tests pass without changes to their assertions, and the CI-only run tests pass
- [ ] #3 The #deciding guard exists once
<!-- AC:END -->
