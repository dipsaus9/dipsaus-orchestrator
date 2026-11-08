---
id: DIPO-464
title: Bring main into a story's branch when main moves
status: Refined
assignee: []
created_date: '2026-11-08 12:17'
updated_date: '2026-11-08 12:35'
labels:
  - 'tier:L'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/conflicts.ts
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/fix-rounds.ts
  - packages/engine/src/run/box-runs.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/box/box-git.ts
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0008-worker-adapter.md
priority: high
type: enhancement
ordinal: 437000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to merge the base branch into a running or parked story's branch whenever the base moved and the branch is behind, so that a story never gets stuck because its box cannot reach main.

M3 (maintainer's choice, 2026-11-08). The trigger: DIPO-457 and DIPO-463 got stuck because main changed under them (DIPO-454 merged under 457, DIPO-458 under 463, each changing the same files), and the box has no route out (0008), so the worker cannot fetch or merge main. Builder agents had to finish both.

This brings back the sync without a conflict that 0002 removed on 2026-10-24: 0002's conflicts part says no sync without a conflict, and its Replaced list removed the building-time sync for tier L and flagged stories because a merge without a conflict was not needed. DIPO-457 and DIPO-463 show it is needed: only dipo can bring main into a box. 0016 stays untouched: GitHub's require-branches-to-be-up-to-date setting stays off (strict off), because dipo does the merge and GitHub does not demand it.

Today dipo merges the base into a story branch only on a conflict: at done (syncInTurn), in the auto-merge's conflict hand-off while the story waits In Review, and at the resume of a conflict park (mergeOnResume); see packages/engine/src/run/conflicts.ts and packages/engine/src/box/collisions.ts. A conflict the PR poll finds while a story is In Review is only recorded as found and waits for the story's next In Review or the auto-merge. The resume of any other park reason and the start of a fix round merge nothing (packages/engine/src/run/park-resume.ts, packages/engine/src/run/fix-rounds.ts). A branch that would merge cleanly never gets the base, so its worker builds against code main already changed.

The fix, one mechanism (0001): the catch-up box runs already use (a merge committed from git objects in dipo's own git, the box copy, a push without force) runs whenever the base moved and the branch lacks base commits, clean or conflicted. It runs before the worker's first turn of the resume of any park reason and of each fix round, and when the PR poll finds a story In Review conflicting with the base, which starts a conflict hand-off fix round at once instead of waiting. A parked story's box is stopped, so it gets the merge at its resume. A clean merge is pushed, copied into the box and also committed in the box's local git by a fixed dipo script (as packages/engine/src/box/box-git.ts makes the start commit), so the worker's git log shows the base's changes and its git diff only its own work. The worker's first message after a catch-up says main is already merged into its branch, names the merged files, and says the box cannot fetch main. A conflict is committed as git left it, copied in and handed to the worker in its first message with the conflicting files listed (the conflict item); no model outside the box resolves it, and a conflict in a path the worker cannot write parks conflict as today. The claim of a reused branch still merges nothing (0010). The merge commit changes neither the PR's diff against the base nor the squash merge, whose subject stays the PR title (0002, 0016).

ADRs: 0002 (its conflicts part is rewritten from no sync without a conflict to the merge when the base moved) and 0008 (the box's git gets the catch-up commit), one Replaced line each; 0016 is not changed. The maintainer approves the wording in the story's PR; the merge gate waits for any change under docs/decisions/ (0002).

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-464/merge-base-when-it-moves"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the resume of a park of each reason merges a moved base into a behind branch before the worker's first turn, clean and conflicted, through the existing catch-up"
    - kind: "automated"
      check: "(unit) a fix round's developer session on a behind branch gets the base merged before the worker's first turn"
    - kind: "automated"
      check: "(unit) a story In Review that the PR poll finds conflicting with the base gets the merge and a conflict hand-off fix round at that poll"
    - kind: "automated"
      check: "(unit) a clean merge is pushed without force, copied into the box and committed in the box's git as its own commit, so git diff in the box shows only the worker's changes"
    - kind: "automated"
      check: "(unit) the worker's first message after a catch-up says main is already merged, names the merged files and says the box cannot fetch main"
    - kind: "automated"
      check: "(unit) a conflicted merge is committed with its markers, copied in and named file by file in the worker's first message; a conflict in a protected path parks conflict and merges nothing"
    - kind: "automated"
      check: "(unit) a branch that already holds the base merges nothing, and the claim of a reused branch merges nothing"
    - kind: "automated"
      check: "(unit) after a catch-up merge commit the PR's diff against the base holds only the story's own changes, and the squash merge request still uses the PR title as its subject and the pushed head"
    - kind: "manual"
      check: "On the scratch repository with a Haiku office, park a running story with dipo park, merge a change to a file the story does not touch on main, then resume the story"
      expect: "the story's PR shows a merge of main before the worker's next part, its Files tab shows only the story's changes, dipo watch shows the catch-up notice naming the merged files, and the run goes on"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the base moved and the story branch lacks base commits, the resume of a park of any reason merges the fetched base into the branch in dipo's own git before the worker's first turn, whether the merge is clean or conflicted
- [ ] #2 Each fix round's developer session gets the same merge before the worker's first turn when the branch is behind the base
- [ ] #3 A story In Review whose branch the PR poll finds conflicting with the base gets the base merged and a conflict hand-off fix round at that poll, instead of waiting for its next In Review or the auto-merge
- [ ] #4 A clean merge is pushed without force, copied into the box and committed in the box's local git as a commit of its own, so the worker's git log shows the base's changes and its git diff shows only its own work
- [ ] #5 The worker's first message after a catch-up says that main is already merged into its branch, names the merged files, and says that the box cannot fetch main
- [ ] #6 A conflicted merge is committed as git left it, copied into the box and handed to the worker in its first message with the conflicting files listed; no model outside the box resolves it, and a conflict in a path the worker cannot write parks the story conflict as today
- [ ] #7 A branch that already holds the base merges nothing, and the claim of a reused branch still merges nothing (0010)
- [ ] #8 A catch-up merge commit leaves the PR's diff against the base with only the story's own changes, and the squash merge still takes the PR title as its subject
- [ ] #9 ADR 0002 brings back the sync without a conflict it removed on 2026-10-24: its no sync without a conflict text is rewritten to the merge when the base moved, giving DIPO-457 and DIPO-463 as the reason, with one Replaced line; ADR 0008 describes the catch-up commit in the box's git with one Replaced line; ADR 0016 stays untouched, since GitHub's up-to-date rule stays off and dipo does the merge; the maintainer approves the wording in the story's PR
<!-- AC:END -->
