---
id: DIPO-206
title: Count budget grants in the work view's usage
status: Done
assignee: []
created_date: '2026-10-18 14:31'
updated_date: '2026-10-19 21:29'
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
- [x] #1 packages/engine/src/views/work.ts and packages/engine/src/views/feature.ts take the budget limit they pass to readUsage from runCaps, so a run with a budget grant shows the start budget plus the grant as Usage.budget.limit in both views
- [x] #2 A test in packages/engine/test/views/ records a budget grant of 5000 tokens on a run with a 20000 token start budget and expects the literal limit 25000 in the work view and in the feature view
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5B0DQXQ1Q95QWF3XJ9QXT1F (Haiku, 15 turns, about $0.01, 2 min) reported done, In Review, with no denied call and no write outside the References. workView and storyRuns now pass runCaps(...).budgetTokens (snapshot plus budget grants) to readUsage, so a run with a grant shows the granted limit in the work view and in story.detail's work. storyRuns keeps only usage.run in its RunRecord, so its limit is not shown; a comment there now says the feature view's limit comes from workView. Verify outside the sandbox: 3696 tests, 0 fail; DIPO_TEST_CI=1 views tests pass. Review passed.
<!-- SECTION:NOTES:END -->
