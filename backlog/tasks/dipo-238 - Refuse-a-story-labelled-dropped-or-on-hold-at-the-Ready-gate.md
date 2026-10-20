---
id: DIPO-238
title: Refuse a story labelled dropped or on-hold at the Ready gate
status: To Do
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:35'
labels:
  - 'tier:S'
  - cutover
  - needs-info
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/backlog/fields/labels.ts
  - packages/engine/test/gate/gate.test.ts
priority: medium
type: enhancement
ordinal: 238000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate fails a story that carries the label `dropped` or `on-hold`, in both modes, so a story the maintainer set aside cannot be made Ready or picked up by mistake.

Context: on 2026-10-20 DIPO-182 (labelled dropped) passed the gate and was nearly set Ready in a backlog bundle, and DIPO-183 (labelled on-hold, with a hold note) was set Ready by an agent; both were caught in review and reverted. The gate rules are R01a/R01b and R02 to R27 in packages/engine/src/gate/rules.ts, evaluated by packages/engine/src/gate/evaluate.ts over the labels readLabels parses (packages/engine/src/backlog/fields/labels.ts: tier, role, test-before-merge, other, invalid); no rule reads `other`. `on-hold` is also a park reason (0001, 0012); `dropped` is a label the maintainer uses on a Refined story. The rule list is 0012 section 3, so a new rule is a dated 0012 note, as R27 was (DIPO-188).

```dipo
branch: "DIPO-238/gate-refuses-set-aside"
unknowns:
  - q: "May the Ready gate get a new rule R28, recorded as a dated 0012 section 3 note: a story labelled dropped or on-hold fails in both modes with 'labelled <label>: the maintainer set it aside; remove the label to make it Ready'? (a) yes, R28 as written (recommended: the gate is the one place both a bundle and a pickup pass through, and two set-aside stories nearly went Ready on 2026-10-20); (b) no rule, the labels stay advisory and bundles check them by hand."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) gate.test.ts: a story labelled dropped and one labelled on-hold fail R28 in ready and pickup mode with the reason naming the label; the same story without the label passes"
    - kind: "automated"
      check: "(unit) gate.test.ts: R28 runs after R27 in rule order, and the failure lists hold every other failing rule as before"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/gate/rules.ts has a rule R28, evaluated in both modes after R27, that fails a story whose labels include `dropped` or `on-hold` with the reason `labelled <label>: the maintainer set it aside; remove the label to make it Ready`, one failure per such label
- [ ] #2 A story with neither label gets no R28 failure, and the other rules' failures and their order are unchanged
- [ ] #3 packages/engine/test/gate/gate.test.ts covers both labels in ready and pickup mode, a story with both labels (two failures) and a story with neither
<!-- AC:END -->
