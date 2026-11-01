---
id: DIPO-416
title: Require the test plan in the worker's report schema
status: Refined
assignee: []
created_date: '2026-11-01 16:07'
labels:
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-413
references:
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/prompts/contract/implement-box.md
  - packages/engine/test/prompts/
  - packages/engine/test/workers/
priority: medium
type: bug
ordinal: 394000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's malformed report that leaves out its test plan is refused by Claude Code's own schema check inside the same turn, so the worker fixes it at once instead of using up the report gate's loop cap.

Gap G23, 2026-11-01, run run_01M6BXDVZ1Q05NXYVD2VA6QT6A of DIPO-413 (Haiku): the first StructuredOutput call held a correct `testPlan` but no `commitSubject`, and the CLI refused it ("must have required property 'commitSubject'"). On each retry the model broke the call's parameters: the test-plan list ended up as text inside another field, and the call had no `testPlan` key. `testPlan` is `exactOptional` in packages/engine/src/workers/claude-cli/report-schema.ts, so the CLI took it, and the report gate (no test-plan entry reported) sent it back three times until the run parked verify-failing. `commitSubject` is required and the CLI caught its absence at once; `testPlan` should work the same way.

Design: `testPlan` becomes required in the report schema; an empty list stays valid (a story whose test plan is `not_applicable`, or a blocked report). The report gate keeps checking which entries are done; only the shape moves into the schema. 0008, 0012.

```dipo
branch: "DIPO-416/report-test-plan-required"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the worker report JSON Schema requires testPlan, so a report without it fails the CLI schema check and an empty list is valid for a story with no automated entries"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker report JSON Schema lists `testPlan` as required, and a report without it fails validation against that schema, shown by a test
- [ ] #2 An empty `testPlan` list is valid, and a done report on a story with automated entries but an empty list is still sent back by the report gate as now, shown by a test
- [ ] #3 The report section of packages/engine/src/prompts/contract/implement-box.md says `testPlan` is always present, empty when the story has no entries, shown by the prompt golden tests
<!-- AC:END -->
