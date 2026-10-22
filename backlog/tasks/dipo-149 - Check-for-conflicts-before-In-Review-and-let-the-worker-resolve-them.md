---
id: DIPO-149
title: >-
  Check conflicts before In Review, let the worker resolve them, refuse conflict
  markers
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 19:26'
labels:
  - 'tier:L'
  - 'slice:m1a'
  - needs-refinement
  - box
  - cutover
milestone: m-1
dependencies:
  - DIPO-142
  - DIPO-148
  - DIPO-284
  - DIPO-290
  - DIPO-292
  - DIPO-294
  - DIPO-299
  - DIPO-302
  - DIPO-152
references:
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/run/
  - packages/engine/src/run/backstop.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/run/
  - packages/engine/test/run/verify-in-box.test.ts
  - packages/engine/test/worktree/
priority: high
type: feature
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine checks with merge-tree before In Review, syncs riskier stories, resolves task-file conflicts itself, parks unwritable-path conflicts at once, leaves other conflicted merges for the worker and parks conflict at the second failed hand-off; a story whose merge or catch-up left conflict markers in a recorded path cannot reach verify, In Review or a PR until they are resolved, decided by code, not by the reviewer.

Context: implements ADR 0019 section 10 (conflicts: when, riskier stories sync while building, leave the merge in progress, attempts; maintainer decisions on conflicts and spike answer 9) and the conflict item of section 8. There is no merge-tree call in engine/src/run/ today; the check was deferred in DIPO-15 and DIPO-49 (0019 fact 4).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). The conflict handoff runs in the worker place: it registers the conflict starter there and appends the conflict run_steps kind that the final run_outcomes row counts as conflict_handoffs.

From DIPO-291: DIPO-277 (PR #323) commits a conflicted catch-up with git's markers and starts a fix round; its review found nothing stops an unresolved marker from reaching review when it sits in a file that is not compiled or tested.

```dipo
branch: "DIPO-149/resolve-conflicts"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, real git under DIPO_TMP) an approved head plus a clean base merge this story's sync made and a task-file commit carries the approval to the new head with no review round, and a base merge the engine did not record starts a round"
    - kind: "automated"
      check: "(integration, real git under DIPO_TMP) a conflicting base leaves the merge in progress and the derived merge state reads the same after a simulated restart"
    - kind: "automated"
      check: "(integration) a task-file conflict is resolved by the engine and a .dipo/ conflict parks unwritable-path"
    - kind: "automated"
      check: "(unit) conflict markers left after the feedback turn count as a failed hand-off, and the second one parks merge-in-progress"
    - kind: "automated"
      check: "(integration) a tier L story merges a clean base before In Review and runs verify again"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the scope check, green verify and the code commit, the engine fetches and runs git merge-tree --write-tree origin/<base> HEAD before the In Review commit; a story of tier L or flagged test-before-merge always merges the base there, reinstalls when the lockfile changed and runs verify again
- [ ] #2 On a conflict the engine runs git merge --no-ff --no-edit origin/<base> in the story worktree and leaves the merge in progress, derives the merge state from git (MERGE_HEAD, unmerged entries, cleanly merged blob ids) without storing it, and refreshes the run's backstop snapshot
- [ ] #3 The engine resolves a conflict in the story's own task file through the single field write path; a conflict in any other path the worker cannot write aborts the merge and parks conflict with cause unwritable-path, naming the paths
- [ ] #4 Other conflicts go as one conflict item (paths and hunks within budget, signed over base commit and sorted paths) to the developer session; at done the conflicted paths must hold no conflict marker lines (one feedback turn otherwise), the scope check counts them in scope, verify runs, and the engine commits the merge with git commit --no-edit --no-verify
- [ ] #5 A blocked report, or markers or unmerged paths left after the feedback turn, is a failed hand-off counted against conflict_cap; the failed hand-off that reaches mergeSlot.conflictAttempts parks conflict with cause merge-in-progress and the paths, with the merge left in progress; a re-claim of a kept branch uses the same hand-off
- [ ] #6 A conflict found by a fetch while a story is In Review raises a notice and shows on the story detail, and is handled at the story's next In Review or merge-slot sync
- [ ] #7 When the engine makes a clean base merge in the story worktree, it writes a carried review_verdicts row (carried from the approved head) through DIPO-146's verdict store, so a review approval of the head before that merge carries over to the merged head when only that merge and task-file commits lie between them, recorded as carried to the new head with no new review round (0019 section 6)
- [ ] #8 (from DIPO-291) dipo records the conflicted paths of each catch-up
- [ ] #9 (from DIPO-291) At done, before verify, a recorded path that still holds a line starting with '<<<<<<< ', '=======' or '>>>>>>> ' on the tip goes back to the worker as a fix-round item
- [ ] #10 (from DIPO-291) The PR is not opened while such a line remains
- [ ] #11 (from DIPO-291) Tests cover a resolved and an unresolved conflict
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: on overlap both stories continue; after the first merges, dipo brings the new main into the second story's branch and box, with a fix round when git cannot merge cleanly (0021 section 12).

2026-10-22: combined from DIPO-291 (maintainer, M1 speed-up)

2026-10-22: dropped the dependency on DIPO-159 (which now holds DIPO-289) to break a dependency cycle left by the M1 combine; that story now comes after this one.
<!-- SECTION:NOTES:END -->
