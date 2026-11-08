---
id: DIPO-467
title: Warn at Ready when a story holds more than its tier usually does
status: Refined
assignee: []
created_date: '2026-11-08 12:17'
updated_date: '2026-11-08 12:35'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/types.ts
  - docs/decisions/0012-story-standard.md
priority: medium
type: enhancement
ordinal: 440000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Ready gate to warn when a story has more criteria or references than its tier usually holds, so that I raise its tier or split it before a run hits its caps.

M3 (maintainer's choice, 2026-11-08). The trigger: DIPO-458 had tier S with 9 criteria and 10 references and reached the tier S turn cap with no part. Tier-labelled stories on main (2026-11-08) hold: S a median of 3 criteria (90th percentile 5) and 4 references; M 6 criteria (90th percentile 10) and 9 references; L 7 criteria (90th percentile 11) and 11 references.

The fix: a new warning rule R32 (packages/engine/src/gate/rules.ts, packages/engine/src/gate/evaluate.ts), which like the reference warning never fails the gate, and which runs in ready mode only, never in pickup mode: it is for the maintainer before Ready, and the pickup stays as it is. Its ceilings are constants in code: tier S 5 criteria and 8 references, tier M 10 and 16, tier L 12 and 24. Its message names the tier, the count and the ceiling, and it shows in dipo gate and the stored gate record. The CI Ready gate check (scripts/check-ready-gate.ts) runs pickup mode, so it does not show R32.

ADR 0012 describes the warning under the warnings that never fail the gate, without a rule number since 0012 numbers none there, and changes its sentence under what the gate does not check that names whether the size is right, with one Replaced line.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-467/warn-story-size-over-tier"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) R32 warns in ready mode for a story above its tier's criteria or reference ceiling and the gate still passes; a story at the ceiling gets no warning"
    - kind: "automated"
      check: "(unit) the ceilings are S 5 and 8, M 10 and 16, L 12 and 24, and the message names the tier, the count and the ceiling"
    - kind: "automated"
      check: "(unit) the R32 warning appears in dipo gate output and the stored gate record, and pickup mode never evaluates it"
    - kind: "manual"
      check: "Run dipo gate on a Refined tier S story with 6 criteria on the scratch repository"
      expect: "the output shows a warning R32 line naming tier S, 6 criteria and the ceiling 5, and the gate passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new gate warning R32 warns when a story's criteria count or reference count is above its tier's ceiling, never fails the gate, and runs in ready mode only, not in pickup mode
- [ ] #2 The ceilings are constants in code, tier S 5 criteria and 8 references, tier M 10 and 16, tier L 12 and 24, and the message names the tier, the count and the ceiling
- [ ] #3 The warning shows in dipo gate and in the stored gate record
- [ ] #4 ADR 0012 describes the warning under the warnings that never fail the gate, without a rule number, and changes the sentence under what the gate does not check that names whether the size is right, with one Replaced line
<!-- AC:END -->
