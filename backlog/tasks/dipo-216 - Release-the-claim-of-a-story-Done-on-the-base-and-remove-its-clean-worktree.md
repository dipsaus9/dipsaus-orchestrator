---
id: DIPO-216
title: Release the claim of a story Done on the base and remove its clean worktree
status: Refined
assignee: []
created_date: '2026-10-19 15:12'
updated_date: '2026-10-19 20:44'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/reconcile/
  - packages/engine/src/stories/index-stories.ts
  - packages/engine/src/worktree/
  - packages/daemon/src/foreground.ts
  - packages/engine/test/reconcile/
  - packages/engine/test/stories/
  - packages/engine/test/worktree/
priority: high
type: bug
ordinal: 216000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: reconcile releases dipo's claim on a story that is Done on the base and removes its worktree when the worktree is clean, so the port slot is free again; a dirty worktree is kept and named in a notice, and no branch is touched.

Context: on 2026-10-19 all 20 port slots were held by worktrees of stories that were Done on main, finished on -finish branches, and the maintainer freed 20 by hand. dipo releases a claim only when Done arrives through the story's own branch: the Done poll (packages/engine/src/worktree/done.ts) checks the branch with the code host and git merge-tree, and then tearDown in packages/engine/src/worktree/teardown.ts unlocks and removes the worktree with git worktree remove without --force, deletes the branch locally and remotely, calls releaseClaim in packages/engine/src/worktree/records.ts with DONE_RELEASE_REASON (done, keepBranch false), forgets the worktree's worker_notes and context_packs and frees the slot. The index pass (indexPass in packages/engine/src/stories/index-stories.ts) reads every task on _base and then replaces each claimed story with its read on the branch (overlayClaimed), so reconcile (packages/engine/src/reconcile/reconcile.ts) never sees the base status of a claimed story. This story adds the minimal release of maintainer answer A on the DIPO-162 split: reuse the worktree steps of tearDown (split from its branch steps), releaseClaim and the slot table, in a reconcile step at daemon start and on office.rescan. DIPO-162 builds on it with the rest of ADR 0020 section 10 (the Done poll check, the done-elsewhere reason, the live-worker desk item, the story PR, branch handling and leftovers). The release reason here is done, as the own-branch path writes it.

```dipo
branch: "DIPO-216/release-claim-done-on-base"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a live claim with teardown_started_at set whose worktree is already gone is released on the next reconcile pass, and a run reopened between the pass and the git queue item keeps its worktree and claim"
    - kind: "automated"
      check: "(integration, real git) two claims whose stories are Done on the base through another branch: the clean worktree is removed, its claim released with reason done and its slot freed; the dirty one keeps its worktree, claim and slot and gets a notice naming its path and files; both branches keep their commits locally and on the remote"
    - kind: "automated"
      check: "(unit) the index pass keeps the base status of a claimed story next to its branch read"
    - kind: "automated"
      check: "(unit) a claim whose run has not ended, and a claimed story not Done on the base, are left alone"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The index pass in packages/engine/src/stories/index-stories.ts keeps, for each claimed story it reads on its branch, the status that story has on _base, and the IndexResult carries it for reconcile; a test in packages/engine/test/stories/ shows a claimed story In Progress on its branch and Done on _base with both statuses
- [ ] #2 Reconcile, at daemon start and on office.rescan, finds each live claim with a claim commit whose story is Done on _base and whose run has ended; for each, in one item of the office git queue that checks again there that the run has ended and the story is Done on _base, it records claims.teardown_started_at as tearDown in packages/engine/src/worktree/teardown.ts does, unlocks the claim's own worktree lock, removes the worktree with git worktree remove without --force, then in one transaction releases the claim through releaseClaim in packages/engine/src/worktree/records.ts with release_reason done and keepBranch false, resolves an open park of the run with resolved_how reconcile, deletes the worktree's worker_notes and context_packs rows and writes an info engine.notice naming the story and the base, and then frees the worktree's port slot
- [ ] #3 A worktree that git refuses to remove (modified or untracked files) or one locked by anyone else is kept: the claim stays live, the slot stays held, the lock is restored, and a warn engine.notice names the worktree path and the files git status lists
- [ ] #4 Neither branch is changed: the release runs no git update-ref -d, git branch -D or git push --delete, and a test shows the local and the remote story branch at the same commit before and after the release
- [ ] #5 A claim whose run has not ended, a claimed story that is not Done on _base, and a claim without a claim commit are left alone by this step, and after any release reconcile runs one more index pass so the story is read on _base
- [ ] #6 A test in packages/engine/test/reconcile/ with a real git repository and remote replays the 2026-10-19 case: two claims of stories Done on the base through another branch, one clean and one with an untracked file; the clean claim is released with reason done, its worktree directory is gone and its slot is free, and the dirty claim keeps its worktree, claim and slot with one notice that lists the untracked file
- [ ] #7 A live claim with teardown_started_at set whose worktree is already gone (a crash between the removal and the release) is released on the next reconcile pass with the same transaction and slot release as the second criterion, without git; a claim whose run was reopened before the git queue item keeps its worktree, lock and claim; tests cover both
<!-- AC:END -->
