---
id: DIPO-363
title: Decide Done in one function from the PR state and the base
status: Done
assignee: []
created_date: '2026-10-28 10:01'
updated_date: '2026-10-28 12:45'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-350
references:
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/reconcile/
  - packages/engine/src/story-pr/
priority: high
type: chore
ordinal: 343000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one pure function decides whether a story is Done from its PR state and the base, the PR poll and reconcile both use it, and git merge-tree is no longer a Done signal.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Split from DIPO-350 (the rest of its criterion 5), which moved merging to GitHub auto-merge and removed the merge slot. 0002 (merging and Done), 0010.

```dipo
branch: "DIPO-363/one-done-function"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the Done function decides merged, Done on the base and not done"
    - kind: "automated"
      check: "(engine) the PR poll and reconcile reach the same Done answer for the same PR state and base"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One pure function decides Done from the PR state and the base, and the PR poll and reconcile both call it
- [x] #2 git merge-tree is no longer a Done signal (0010), and detectDone, worktree/done.ts and reconcile/done-on-base.ts use the one function or are removed
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
decideDone (worktree/done-check.ts) is the one pure Done function: from the run's recorded story PR, the host's answer for that same PR number, and the story's status on _base it answers merged, doneOnBase or notDone. The Done poll and reconcile both call it with facts gathered the same way (claimPr), and review start and discard use it too. git merge-tree is no longer a Done signal and only decides whether a merged branch that moved past the merged head may be deleted. A merged PR from an earlier claim of the same branch never counts, a host failure on an open PR answers notDone for that round, and three host failures in a row on a claim raise a done.hostUnreachable notice. detectDone, doneOnOwnBranchIn, ownMergedPr and the merge-tree Done rule are removed.
<!-- SECTION:FINAL_SUMMARY:END -->
