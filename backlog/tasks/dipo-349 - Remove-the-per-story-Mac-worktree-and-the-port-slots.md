---
id: DIPO-349
title: Remove the per-story Mac worktree and the port slots
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-29 07:29'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-348
  - DIPO-347
  - DIPO-309
  - DIPO-350
references:
  - packages/engine/src/worktree/
  - packages/engine/src/run/
  - packages/engine/src/reconcile/
  - packages/engine/src/scan/
  - packages/engine/src/db/
  - packages/daemon/src/
priority: high
type: chore
ordinal: 329000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a claim creates no Mac worktree: task-file edits run in dipo's own folder, the reviewer and the Done check read git objects, and the worktree setup, lock, teardown and the machine-wide port slots are removed.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 9; 0008, 0010). The test box of DIPO-309 replaces testing in the worktree.

```dipo
branch: "DIPO-349/remove-mac-worktree-port-slots"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine, temp repos) a story runs from claim to In Review with no worktree under the worktree root"
    - kind: "automated"
      check: "(db) the migration drops run_ports"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A claim runs no git worktree add, and nothing reads or writes files of a per-story worktree
- [x] #2 Reconcile finds hand changes from the branch refs and recorded SHAs instead of a worktree
- [x] #3 Port slots, slots.json and the run_ports table are removed, and teardown deletes only the branch and the box
- [x] #4 At daemon start, a clean leftover worktree of an earlier binary is removed and a dirty one is listed on the desk
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A claim is update-ref plus its claims row; no story has a Mac worktree. Task-file edits run the Backlog CLI in a clean folder and commit the file from git objects on the branch ref with the old SHA as lease. Reconcile reads hand changes from branch refs against the claim commit and pushed head. Port slots, slots.json, dev-port detection and run_ports (migration 65) are gone; teardown deletes the branch and the box. At office load a leftover locked dipo worktree is removed when clean or when every changed path is held by git, else listed on the desk. 0010 and 0013 updated (maintainer approved the reused-branch and dev-port changes).
<!-- SECTION:FINAL_SUMMARY:END -->
