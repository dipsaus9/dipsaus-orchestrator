---
id: DIPO-161
title: >-
  Discard a story's work and release a claim whose story is Done on the base
  through another branch
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-144
  - DIPO-160
  - DIPO-228
  - DIPO-186
  - DIPO-284
  - DIPO-159
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-294
  - DIPO-295
  - DIPO-299
  - DIPO-301
  - DIPO-302
  - DIPO-152
  - DIPO-296
  - DIPO-158
  - DIPO-216
  - DIPO-226
references:
  - packages/cli/src/
  - packages/contract/schema/
  - packages/contract/src/
  - packages/daemon/src/
  - packages/engine/src/backlog/lane/
  - packages/engine/src/backlog/pr/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/features.ts
  - packages/engine/src/reconcile/
  - packages/engine/src/run/
  - packages/engine/src/stories/
  - packages/engine/src/views/
  - packages/engine/src/worktree/
  - packages/engine/test/backlog/
  - packages/engine/test/db/
  - packages/engine/test/reconcile/
  - packages/engine/test/run/
  - packages/engine/test/worktree/
priority: high
type: feature
ordinal: 150000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo discard <id> lists what is lost, then ends the run, removes the worktree and branch, closes the PR and returns the story to Refined; and the Done poll and reconcile release a parked or idle claim whose story is Done on the base through another branch, flag one with a live worker, and put kept leftovers on the desk.

Context: implements the work.discard row of ADR 0020 section 8 and its dirty-worktree option, on the waiting command path of the 0005 note of 2026-10-17. The loss list comes from the office read story.losses that DIPO-228 adds (maintainer, 2026-10-20), so this story depends on it. In M0 work.discard is unregistered, so DIPO-105's parked work could not be cleaned up from dipo (0020, real cases from the cutover).

From DIPO-162: implements ADR 0020 section 10 (a story finished outside dipo; spike answer 5). Today Done detection looks only at the story's own branch and reconcile reads a claimed story's status on its branch (0020 fact 9), so DIPO-105, finished by hand on another branch, kept its claim, worktree and branch. The minimal release now lives in DIPO-216: reconcile releases the claim of a story Done on the base with reason done and removes its clean worktree, keeping both branches; this story builds on it and keeps the rest (the Done poll check, done-elsewhere, the live-worker desk item, the story PR, branch handling, leftovers and discard).

```dipo
branch: "DIPO-161/discard-and-release"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, real git) discard of a parked story with uncommitted files removes worktree and branch and writes Refined"
    - kind: "automated"
      check: "(unit) a merged story PR refuses discard and a remote tip the engine did not push keeps the remote branch with a notice"
    - kind: "automated"
      check: "(unit, cli) dipo discard prints the loss list and sends the command only after the typed id"
    - kind: "automated"
      check: "(unit) discard of a story Done on the base removes its worktree and branch and writes nothing to the backlog; discard of a story whose PR head changed outside dipo goes on"
    - kind: "automated"
      check: "(unit) commands.describe lists work.discard with since 1 and irreversible, and it runs on the waiting command path"
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
- [ ] #1 dipo discard <id> --note <text> lists the commits not on the base and the uncommitted and untracked files, read through story.losses (DIPO-228), then asks for the typed story id; commands.describe marks work.discard irreversible
- [ ] #2 Discard stops an active run as work.stop does, releases the claim, removes the worktree with --force, deletes the branch locally and remotely, closes open questions, frees the slot, closes the open story PR with a comment naming the discard, resolves an open park as discard and writes Refined in lane b
- [ ] #3 Discard refuses a story whose PR in story_prs is merged, and a remote branch whose tip the engine did not push is not deleted (a notice) while the other steps go on
- [ ] #4 Discard also works on the leftovers of a story Done on the base, writing nothing to the backlog, and on a story whose PR head changed outside dipo
- [ ] #5 work.discard is registered with its since on the waiting command path
- [ ] #6 (from DIPO-162) The Done poll and reconcile read a claimed story's status on the base after a fetch, and a Done there wins over the branch status when the branch is not detected Done
- [ ] #7 (from DIPO-162) A parked or idle claim is released in one transaction with reason done-elsewhere: run ended, open park resolved done-elsewhere (added to the parks check by migration), questions closed ended, story.state Done, and a notice naming the base commit that last changed the task file
- [ ] #8 (from DIPO-162) dipo's open story PR is closed with a comment naming that commit; a clean worktree is removed and a dirty one kept; the branch is deleted locally and remotely when merge-tree shows it adds nothing to the base, else kept in released_branches with reason done-elsewhere; this replaces DIPO-216's interim reconcile release (reason done, resolved_how reconcile, a dirty worktree keeping its claim live) for the claims it covers: a dirty worktree is kept as leftovers while its claim is released (0020 section 10)
- [ ] #9 (from DIPO-162) A claim with a live worker is not stopped: a DONE ELSEWHERE desk item and an engine.notice are raised, and the release happens at the run's next end
- [ ] #10 (from DIPO-162) Anything kept is one LEFTOVERS desk item with the commits not on the base, the dirty files and the action dipo discard <id>, and leftovers are never deleted automatically. An own-branch teardown that crashed after removing its worktree is now released by DIPO-216's reconcile step as done with its branch kept; this leftover handling also deletes such a branch locally and remotely when merge-tree shows it adds nothing to the base
- [ ] #11 (from DIPO-162) A test replays the DIPO-105 case: the claim is released, the worktree with uncommitted files and the branch are kept, and one leftovers item is on the desk
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: the story's box lives until merge, so discard and release must also tear down the box (0021 section 6).

Carried from DIPO-162: Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: the story's box lives until merge, so discard and release must also tear down the box (0021 section 6).

2026-10-22: combined from DIPO-162 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
