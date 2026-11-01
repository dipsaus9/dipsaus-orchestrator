---
id: DIPO-416
title: Require the test plan in the worker's report schema
status: Refined
assignee: []
created_date: '2026-11-01 16:07'
updated_date: '2026-11-01 16:09'
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

Gap G23, 2026-11-01, run run_01M6BXDVZ1Q05NXYVD2VA6QT6A of DIPO-413 (Haiku): the first StructuredOutput call held a correct `testPlan` but no `commitSubject`, and the CLI refused it (\

Design: the JSON Schema passed to the CLI (`WORKER_REPORT_JSON_SCHEMA`) requires `testPlan`; `WorkerReport.testPlan` in types.ts and the parser (`parseWorkerReport`, the worker event schema) stay optional, so the committed live recordings and scripted turns, which have no `testPlan`, still parse (0017). An empty list stays valid (a story whose test plan is `not_applicable`, or a blocked report). The report gate keeps checking which entries are done; only the shape moves into the CLI's schema. 0008, 0012.

```dipo
branch: "DIPO-416/report-test-plan-required"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the JSON Schema passed to the CLI requires testPlan, so a report without it fails the CLI schema check, while the parser and every committed recording still accept a report without it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The JSON Schema passed to the CLI lists `testPlan` as required, and a report without it fails validation against that schema, shown by a test (the existing required-list test in report-schema.test.ts becomes status, criteria, summary, commitSubject, testPlan)
- [ ] #2 An empty `testPlan` list is valid, and a done report on a story with automated entries but an empty list is still sent back by the report gate as now, shown by a test
- [ ] #3 The report section of packages/engine/src/prompts/contract/implement-box.md says `testPlan` is always present, empty when the story has no entries, shown by the prompt golden tests
- [ ] #4 `parseWorkerReport` and the worker event schema still accept a report without `testPlan`, so every committed recording and scripted turn replays with its current outcome, shown by the existing recordings and scripted tests passing unchanged
<!-- AC:END -->
