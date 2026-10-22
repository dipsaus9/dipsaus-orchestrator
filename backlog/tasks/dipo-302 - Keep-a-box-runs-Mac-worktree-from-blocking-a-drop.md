---
id: DIPO-302
title: Keep a box run's Mac worktree from blocking a drop
status: To Do
assignee: []
created_date: '2026-10-22 14:25'
updated_date: '2026-10-22 14:25'
labels:
  - 'tier:S'
  - box
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/stories/planning.ts
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/test/worktree/
priority: medium
type: bug
ordinal: 291000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo drop of a parked box-run story does not fail on its Mac worktree, which only ever held the start commit.

Context: after the first box run (DIPO-248) the story's Mac worktree stayed at the start commit while dipo moved the branch with update-ref for each part, so the worktree showed the parts reversed as staged changes and dipo drop refused it as story.dirtyWorktree. The files matched the start commit exactly; the maintainer side had to reset the worktree by hand.

```dipo
branch: "DIPO-302/box-worktree-drop"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For a box run, drop and the other releases treat a worktree whose files equal the start commit, or the branch tip, as clean, or a box run keeps no Mac worktree
- [ ] #2 A worktree with files that match neither is still refused, as today
- [ ] #3 Tests cover both
<!-- AC:END -->
