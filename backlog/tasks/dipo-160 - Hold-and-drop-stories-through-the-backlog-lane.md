---
id: DIPO-160
title: Hold and drop stories through the backlog lane
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 21:07'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
  - DIPO-144
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/backlog/lane/
  - packages/engine/src/stories/
  - packages/engine/src/worktree/
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/backlog/
  - packages/engine/src/run/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 149000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo hold and dipo drop work as ADR 0020 section 8 says, including the resume of an on-hold story and closing an open story PR, so the maintainer can set a story aside or remove it without editing task files.

Context: implements the hold and drop rows of ADR 0020 section 8 and their options (hold of a claimed story refused, an open PR closed with a comment, the branch kept unless deleteBranch, forced removal of a dirty worktree only behind a typed confirmation), on the waiting command path of the 0005 note of 2026-10-17. story.hold and story.drop are provisional and unregistered today (0020 fact 7).

```dipo
branch: "DIPO-160/hold-and-drop-stories"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) dropping a Parked story resolves its open park with resolved_how drop"
    - kind: "automated"
      check: "(unit) commands.describe declares story.drop with irreversibleWhen deleteBranch"
    - kind: "automated"
      check: "(unit) hold writes the lane-b op and refuses a running story and a claimed parked story with story.notHoldable"
    - kind: "automated"
      check: "(unit) resume of an on-hold story lifts F16 in lane b"
    - kind: "automated"
      check: "(unit) drop refuses In Progress, a story with active dependents and a dirty worktree, and closes an open story PR with a comment"
    - kind: "automated"
      check: "(integration, real git) drop --delete-branch removes a dirty worktree and deletes the branch locally and on the remote"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 story.hold (dipo hold <id> --note <text>) on a Refined or Ready story journals a lane-b hold writing F16 with reason on-hold, from and note, and status Parked, and the pending-op skip applies at once
- [ ] #2 Hold of a running story answers story.notHoldable naming dipo stop, and hold of a parked story with a claim answers story.notHoldable naming resume and discard
- [ ] #3 work.resume of an on-hold park removes F16 in lane b and sets park.from, and a story returned to Ready goes through the pickup re-check at the next work.run
- [ ] #4 story.drop (dipo drop <id> [--delete-branch]) on a Draft, Refined, Ready or Parked story releases any claim, archives the story in lane b and emits story.state Removed; it answers story.active for In Progress or In Review, story.hasDependents when another active story depends on it, and story.dirtyWorktree listing the files when the worktree is dirty and --delete-branch is absent; dropping a Parked story resolves its open park with resolved_how drop (0020 section 8)
- [ ] #5 Drop closes an open story PR from story_prs with a comment naming the drop; without --delete-branch it removes the worktree and records the branch as released, with it it removes the worktree with --force and deletes the branch locally and remotely after a typed confirmation, and commands.describe declares irreversibleWhen deleteBranch
- [ ] #6 story.hold and story.drop are registered with their since on the waiting command path
<!-- AC:END -->
