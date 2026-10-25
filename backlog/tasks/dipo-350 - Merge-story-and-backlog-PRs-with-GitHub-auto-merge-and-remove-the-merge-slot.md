---
id: DIPO-350
title: Merge story and backlog PRs with GitHub auto-merge and remove the merge slot
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
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
Outcome: an approved merge gate leads to one close-out commit and gh pr merge --auto --squash --match-head-commit for story and backlog PRs alike, the required checks are GitHub's own list, one Done check decides Done, and the merge slot is removed.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 5; 0002 sections 7 and 8). The repository setting Allow auto-merge is on.

```dipo
branch: "DIPO-350/github-auto-merge"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine, fake host) an approved gate sends the close-out and gh pr merge --auto with the head"
    - kind: "automated"
      check: "(engine, fake host) a hold label, a foreign head, a conflict and red checks each turn auto-merge off with the right next step"
    - kind: "automated"
      check: "(unit) the Done function decides merged, Done on the base and not done"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a merge gate is approved dipo commits the close-out (summary, status Done), pushes, and runs gh pr merge --auto --squash --match-head-commit with that head
- [ ] #2 The PR poll turns auto-merge off and starts a fix round on a conflict or red checks, and turns it off and reopens the gate on a hold label or a head dipo did not push
- [ ] #3 A release-path PR and a PR labelled autorelease: pending never get auto-merge, and dipo never passes --admin
- [ ] #4 The required checks are the ones GitHub requires; the office list mergeSlot.requiredChecks is no longer read
- [ ] #5 One function decides Done from the PR state and the base, used by the PR poll and reconcile, and the merge slot code and its table are removed
<!-- AC:END -->
