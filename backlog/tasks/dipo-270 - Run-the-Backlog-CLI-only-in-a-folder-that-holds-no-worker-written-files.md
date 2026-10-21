---
id: DIPO-270
title: Run the Backlog CLI only in a folder that holds no worker-written files
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 14:38'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies: []
references:
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/backlog/lane/
  - packages/daemon/src/runs.ts
  - packages/engine/test/backlog/
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/story-pr/git.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/run/control.test.ts
priority: high
type: feature
ordinal: 259000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every Backlog CLI call dipo makes for a story runs in a folder that holds no file a worker wrote, with a minimal environment, so nothing a worker delivers can influence how dipo's own tools run (0021 section 14).

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-270/backlog-cli-clean-folder"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Status, criteria and park edits of a story's task file run in a folder that holds only dipo's own copy of the backlog, never the worktree a worker's files land in
- [x] #2 Every Backlog CLI call gets a minimal, explicit environment instead of the daemon's
- [x] #3 A test shows that files a worker could deliver into the story's worktree do not reach the folder or the environment a Backlog CLI call uses
- [x] #4 The claim, In Review, park and lane paths all use this route
<!-- AC:END -->
