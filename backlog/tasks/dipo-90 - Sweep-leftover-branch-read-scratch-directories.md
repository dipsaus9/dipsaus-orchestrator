---
id: DIPO-90
title: Sweep leftover branch-read scratch directories
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/stories/branch-read.ts
  - packages/engine/src/worktree/
  - packages/daemon/src/foreground.ts
  - packages/engine/test/worktree/sweep.test.ts
priority: medium
type: feature
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no _branch-read-* directory stays under the worktree root after a daemon crash or kill; the daemon removes leftovers when it loads an office.

Context: seen in the M0 delivery sessions: _branch-read-* directories piled up under the worktree root. readOnBranch makes the scratch directory with mkdtempSync and removes it in a finally (packages/engine/src/stories/branch-read.ts:71-89), so a daemon killed or crashed mid-read leaves it. BRANCH_READ_PREFIX (packages/engine/src/stories/branch-read.ts:30) is not used by any sweep.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Office load (recovery) removes every <worktree root>/_branch-read-* directory older than the daemon start before any branch read runs, and logs how many it removed.
- [x] #2 A sweep never touches a claim worktree, _base, or any path not starting with BRANCH_READ_PREFIX.
- [x] #3 A test leaves two scratch directories and a claim worktree, loads the office, and finds only the claim worktree.
<!-- AC:END -->
