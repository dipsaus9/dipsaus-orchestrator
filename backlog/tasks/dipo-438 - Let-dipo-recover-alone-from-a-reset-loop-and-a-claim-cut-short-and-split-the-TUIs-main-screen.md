---
id: DIPO-438
title: Release a claim that a daemon crash cut short without the maintainer
status: Ready
assignee: []
created_date: '2026-11-03 09:54'
updated_date: '2026-11-04 15:57'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/engine/src/worktree/claim.ts
  - packages/engine/test/worktree/claim.test.ts
priority: medium
type: enhancement
ordinal: 411000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a story whose claim was cut short by a daemon crash to be released by dipo itself, so that a crash during a claim never needs my hands.

From the M1 close-out review (finding M1-11). In the planning interview of 2026-11-04 this story kept only this part of DIPO-438; the TUI split became DIPO-443 and the reload loop went to the not-now list. Does not block M2; with several stories claiming at once the case comes up more often.

When the daemon dies between the claim commit and updateClaim in packages/engine/src/worktree/claim.ts, the branch keeps the claim commit. At the next start the interrupted-setup rollback finds a tip past startSha, leaves the branch, posts claim.leftover and holds the story out until the maintainer clears it. Built by builder agents: the claim is on dipo's run path.

The fix treats a tip whose only commit past startSha is dipo's own claim commit for this story as made by this claim, and resets it (design choice, not a maintainer decision; the maintainer may change it before a run).

```dipo
branch: "DIPO-438/reset-backoff-claim-crash-tui-split"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) claim.test.ts: a daemon stop after the claim commit and before the claim is recorded is rolled back at the next start with no notice; a branch with a foreign commit still gets claim.leftover"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a daemon stop between the claim commit and the recorded claim, the next start rolls the claim back without the maintainer: a branch whose only commit past its start is dipo's claim commit for this story is reset or deleted, with no claim.leftover notice
- [ ] #2 A branch with any other commit past its start is still left for the maintainer with the claim.leftover notice
- [ ] #3 dipo recognises a commit as its own claim commit for this story only when its parent is the claim's start commit and it changes only the story's task file, and that change sets the status to In Progress
- [ ] #4 A commit with the claim commit's subject (<ID>: status In Progress) that has another parent or changes anything else still leaves the branch for the maintainer with the claim.leftover notice
<!-- AC:END -->
