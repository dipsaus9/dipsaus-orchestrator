---
id: DIPO-162
title: Release a claim when a story is Done on the base through another branch
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-20 07:19'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-144
  - DIPO-158
  - DIPO-161
  - DIPO-216
  - DIPO-226
references:
  - packages/engine/src/worktree/
  - packages/engine/src/reconcile/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/views/
  - packages/daemon/src/
  - packages/engine/test/worktree/
  - packages/engine/test/reconcile/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 151000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Done poll and reconcile release a parked or idle claim whose story is Done on the base, flag one with a live worker, and put kept leftovers on the desk, so a story finished outside dipo no longer holds a claim, worktree and branch.

Context: implements ADR 0020 section 10 (a story finished outside dipo; spike answer 5). Today Done detection looks only at the story's own branch and reconcile reads a claimed story's status on its branch (0020 fact 9), so DIPO-105, finished by hand on another branch, kept its claim, worktree and branch. The minimal release now lives in DIPO-216: reconcile releases the claim of a story Done on the base with reason done and removes its clean worktree, keeping both branches; this story builds on it and keeps the rest (the Done poll check, done-elsewhere, the live-worker desk item, the story PR, branch handling, leftovers and discard).

```dipo
branch: "DIPO-162/release-claim-done-elsewhere"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) an own-branch teardown that crashed after removing its worktree, released by the DIPO-216 reconcile step with its branch kept, has that branch deleted locally and remotely when merge-tree shows it adds nothing to the base"
    - kind: "automated"
      check: "(integration, real git) a story Done on the base through another branch releases a parked claim and keeps a dirty worktree as leftovers"
    - kind: "automated"
      check: "(unit) a live worker gets a DONE ELSEWHERE item and is released only at the run's next end"
    - kind: "automated"
      check: "(unit) a branch that adds nothing to the base is deleted and one with extra commits is kept in released_branches"
    - kind: "automated"
      check: "(migration) parks.resolved_how accepts done-elsewhere"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Done poll and reconcile read a claimed story's status on the base after a fetch, and a Done there wins over the branch status when the branch is not detected Done
- [ ] #2 A parked or idle claim is released in one transaction with reason done-elsewhere: run ended, open park resolved done-elsewhere (added to the parks check by migration), questions closed ended, story.state Done, and a notice naming the base commit that last changed the task file
- [ ] #3 dipo's open story PR is closed with a comment naming that commit; a clean worktree is removed and a dirty one kept; the branch is deleted locally and remotely when merge-tree shows it adds nothing to the base, else kept in released_branches with reason done-elsewhere; this replaces DIPO-216's interim reconcile release (reason done, resolved_how reconcile, a dirty worktree keeping its claim live) for the claims it covers: a dirty worktree is kept as leftovers while its claim is released (0020 section 10)
- [ ] #4 A claim with a live worker is not stopped: a DONE ELSEWHERE desk item and an engine.notice are raised, and the release happens at the run's next end
- [ ] #5 Anything kept is one LEFTOVERS desk item with the commits not on the base, the dirty files and the action dipo discard <id>, and leftovers are never deleted automatically. An own-branch teardown that crashed after removing its worktree is now released by DIPO-216's reconcile step as done with its branch kept; this leftover handling also deletes such a branch locally and remotely when merge-tree shows it adds nothing to the base
- [ ] #6 A test replays the DIPO-105 case: the claim is released, the worktree with uncommitted files and the branch are kept, and one leftovers item is on the desk
<!-- AC:END -->
