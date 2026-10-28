---
id: DIPO-350
title: Merge story and backlog PRs with GitHub auto-merge and remove the merge slot
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 11:03'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-348
references:
  - packages/engine/src/merge-slot/
  - packages/engine/src/story-pr/
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/reconcile/
  - packages/engine/src/backlog/
  - packages/engine/src/platform/host.ts
  - packages/engine/src/db/
priority: high
type: feature
ordinal: 330000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an approved merge gate leads to one close-out commit and gh pr merge --auto --squash --match-head-commit for story and backlog PRs alike, the required checks are GitHub's own list, and the merge slot is removed.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 5; 0002 sections 7 and 8). The repository setting Allow auto-merge is on. The one Done function moved to DIPO-363.

```dipo
branch: "DIPO-350/github-auto-merge"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine, fake host) an approved gate sends the close-out and gh pr merge --auto with the head"
    - kind: "automated"
      check: "(engine, fake host) a hold label, a foreign head, a conflict and red checks each turn auto-merge off with the right next step"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When a merge gate is approved dipo commits the close-out (summary, status Done), pushes, and runs gh pr merge --auto --squash --match-head-commit with that head
- [x] #2 The PR poll turns auto-merge off and starts a fix round on a conflict or red checks, and turns it off and reopens the gate on a hold label or a head dipo did not push
- [x] #3 A release-path PR and a PR labelled autorelease: pending never get auto-merge, and dipo never passes --admin
- [x] #4 The required checks are the ones GitHub requires; the office list mergeSlot.requiredChecks is no longer read
- [x] #5 The merge slot code and its table are removed, and backlog PRs use the same auto-merge path
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
An approved merge gate leads to one close-out commit, one push and gh pr merge --auto --squash --match-head-commit with that head, for story and backlog PRs alike; --admin is never passed. While auto-merge is on, each poll turns it off on a conflict (fix round with the base merged in), red checks (CI fix round), a hold label or a head dipo did not push (gate reopened). A release-path PR (the base's CODEOWNERS, read after a fetch) or one labelled autorelease: pending never gets auto-merge, also when either appears later. Every park and lift first turns auto-merge off in the office's auto-merge queue and fails closed when it cannot, and a story that stops waiting has it turned off each round. Required checks come from GitHub's branch protection and rulesets, and an empty or unreadable list never counts as green. The backlog lane holds a branch until a round has read its PR. The merge slot and its table are removed (migration 0062). The one Done function moved to DIPO-363.
<!-- SECTION:FINAL_SUMMARY:END -->
