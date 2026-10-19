---
id: DIPO-149
title: Check for conflicts before In Review and let the worker resolve them
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 21:18'
labels:
  - 'tier:L'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-142
  - DIPO-148
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/run/backstop.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/test/run/
  - packages/engine/test/worktree/
  - packages/engine/src/run/
priority: high
type: feature
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine checks with merge-tree before In Review, syncs riskier stories, resolves task-file conflicts itself, parks unwritable-path conflicts at once, leaves other conflicted merges in progress for the worker, concludes them after markers, scope and verify pass, and parks conflict at the second failed hand-off.

Context: implements ADR 0019 section 10 (conflicts: when, riskier stories sync while building, leave the merge in progress, attempts; maintainer decisions on conflicts and spike answer 9) and the conflict item of section 8. There is no merge-tree call in engine/src/run/ today; the check was deferred in DIPO-15 and DIPO-49 (0019 fact 4).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). The conflict handoff runs in the worker place: it registers the conflict starter there and appends the conflict run_steps kind that the final run_outcomes row counts as conflict_handoffs.

```dipo
branch: "DIPO-149/conflict-check-and-worker-hand-off"
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
<!-- AC:END -->
