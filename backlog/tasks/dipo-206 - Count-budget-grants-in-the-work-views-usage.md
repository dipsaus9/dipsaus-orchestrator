---
id: DIPO-206
title: Count budget grants in the work view's usage
status: In Progress
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-19 21:17'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/views/work.ts
  - packages/engine/src/views/feature.ts
  - packages/engine/test/views/
priority: medium
type: bug
ordinal: 206000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the work view's and the feature view's `Usage.budget.limit` and budget share count the run's budget grants, as run control and the resumer already do.

Context: review of DIPO-143 (PR #214). runCaps (packages/engine/src/run/caps.ts) is the one reader of a run's caps: the start snapshot plus its grants. packages/engine/src/views/work.ts still passes `budgetLimit: run.budgetLimit` (the snapshot without grants) to readUsage, and packages/engine/src/views/feature.ts passes `budgetLimit: row.budget_limit` the same way, so after a top-up (DIPO-156) the TUI and `dipo watch` would show the old limit and a share above 100% while run control lets the run go on. views/ was outside DIPO-143's References.

```dipo
branch: "DIPO-206/work-view-budget-grants"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a run with a recorded budget grant shows the snapshot plus the grant as its budget limit in the work view and in the feature view, and a run without grants shows the snapshot in both"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/views/work.ts and packages/engine/src/views/feature.ts take the budget limit they pass to readUsage from runCaps, so a run with a budget grant shows the start budget plus the grant as Usage.budget.limit in both views
- [ ] #2 A test in packages/engine/test/views/ records a budget grant of 5000 tokens on a run with a 20000 token start budget and expects the literal limit 25000 in the work view and in the feature view
<!-- AC:END -->
