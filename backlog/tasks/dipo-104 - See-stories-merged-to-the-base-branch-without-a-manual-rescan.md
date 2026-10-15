---
id: DIPO-104
title: See stories merged to the base branch without a manual rescan
status: To Do
assignee: []
created_date: '2026-10-15 19:23'
updated_date: '2026-10-15 20:52'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/stories/feature.ts
  - packages/engine/src/stories/apply.ts
  - packages/engine/src/commands/execute.ts
  - packages/engine/src/commands/registry.ts
  - packages/engine/test/commands/execute.test.ts
  - packages/engine/test/stories/index.ci.test.ts
  - packages/engine/test/run/work-run.ci.test.ts
priority: medium
type: feature
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story added or changed on the office base branch (for example a Ready story merged by PR) appears in the daemon's view within polling.fetchSeconds, without dipo office rescan or a daemon restart.

Context: seen in the DIPO-84 test on 2026-10-15: TASK-5 was merged to the scratch repo main while a daemon was running, and dipo did not see it until a rescan. The fetch loop is meant to index again when _base moved (packages/engine/src/stories/feature.ts:3); why it did not is unknown.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cause is reproduced with a test and written in the story notes.
- [ ] #2 A story merged to the remote base branch while the daemon runs shows in the office stories within one fetch interval, and work.run can pick it.
- [ ] #3 A test with a temp remote covers the merge-then-poll case.
<!-- AC:END -->
