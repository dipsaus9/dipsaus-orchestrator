---
id: DIPO-209
title: Write golden plans that pass the formatter when they are regenerated
status: Refined
assignee: []
created_date: '2026-10-18 14:32'
updated_date: '2026-10-18 14:32'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
priority: low
type: chore
ordinal: 209000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: regenerating the plan golden files with DIPO_UPDATE_GOLDEN=1 writes files that `bun run format:check` accepts, so a worker that regenerates them does not fail verify on formatting.

Context: M1a run of DIPO-204 on 2026-10-18 and its review (PR #210). The golden writer in packages/engine/test/workers/plan.test.ts writes `JSON.stringify(value, null, 2)`, while oxfmt puts short arrays such as denyRead and allowRead on one line, so a regenerated golden fails format:check until format:fix runs. The worker had to reformat them by hand. The comparison reads parsed JSON, so only the written text changes.

```dipo
branch: "DIPO-209/formatted-golden-plans"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) regenerating the plan goldens leaves no formatting difference: format:check passes on the written files"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The golden writer in packages/engine/test/workers/plan.test.ts writes files in the formatter's own layout, so running the test with DIPO_UPDATE_GOLDEN=1 and then oxfmt --check on packages/engine/test/workers/golden/ reports no change
- [ ] #2 The committed golden files are unchanged in content, and bun run verify passes
<!-- AC:END -->
