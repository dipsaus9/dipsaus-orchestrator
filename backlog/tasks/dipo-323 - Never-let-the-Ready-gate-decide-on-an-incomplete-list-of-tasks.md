---
id: DIPO-323
title: Never let the Ready gate decide on an incomplete list of tasks
status: Done
assignee: []
created_date: '2026-10-23 09:10'
updated_date: '2026-10-23 09:43'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - '- packages/engine/src/gate/'
  - packages/engine/src/backlog/index.ts
  - packages/engine/src/backlog/list.ts
  - packages/engine/src/gate/store/read.ts
  - packages/engine/src/office/init/init.ts
  - packages/engine/src/office/init/ops.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/stories/read.ts
  - packages/engine/test/backlog/list.test.ts
  - packages/engine/test/gate/
  - packages/engine/test/gate/gate-input-complete.test.ts
  - packages/engine/test/gate/gate-tasks.test.ts
  - packages/engine/test/office/init/helpers.ts
  - packages/engine/test/reconcile/helpers.ts
  - packages/engine/test/stories/index-list-complete.test.ts
  - scripts/check-ready-gate.test.ts
  - scripts/check-ready-gate.ts
priority: high
type: bug
ordinal: 308000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate check (the daemon's gate read and the CI script) either decides on the complete list of the office's active tasks or fails loudly with the Backlog CLI's error; it never reports a false rule failure such as "dependency DIPO-284 is not an active task" for a task that exists.

Context: on 2026-10-23 the CI Ready gate test failed twice on two PRs with R13 for a dependency with status Done that exists in backlog/tasks/ (DIPO-284 and DIPO-285); the same commit passed locally and on a re-run. The test took 65 to 83 s on CI, where packages/engine/src/gate/store/read.ts views every listed task through the Backlog CLI. 0012 (the Ready gate).

```dipo
branch: "DIPO-323/gate-input-complete"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a gate input read whose CLI view of one listed task fails or times out fails the check with the CLI error instead of dropping the task"
    - kind: "automated"
      check: "(unit) the repository's Ready stories pass the CI gate check with a slow fake CLI"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The PR names the cause of the false R13 failures
- [x] #2 The gate input is complete or the check fails with the CLI error; no listed task is dropped silently
- [x] #3 A test reproduces the cause with a fake CLI and shows the fix
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23: built outside dipo, reviewed (pass). Cause: the end of the backlog task list output was lost on CI (the missing task was always near the end; the CLI exited 0). Every list reader now checks the entries against --count, retries once, and fails loudly otherwise.
<!-- SECTION:NOTES:END -->
