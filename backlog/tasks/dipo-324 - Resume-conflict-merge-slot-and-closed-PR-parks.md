---
id: DIPO-324
title: 'Resume conflict, merge slot and closed-PR parks'
status: Done
assignee: []
created_date: '2026-10-23 09:11'
updated_date: '2026-10-23 12:22'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-150
references:
  - '- packages/engine/src/run/park-resume.ts'
  - docs/decisions/0019-review-loop.md
  - docs/decisions/0020-park-and-resume.md
  - packages/daemon/src/runs.ts
  - packages/daemon/test/unit/box-runs.test.ts
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/db/migrations/0052-story-pr-replaces.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/merge-slot/
  - packages/engine/src/merge-slot/slot.ts
  - packages/engine/src/merge-slot/story-git.ts
  - packages/engine/src/merge-slot/story-slot.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/conflicts.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/resume-policy.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/story-pr/
  - packages/engine/src/story-pr/body.ts
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/story-pr/records.ts
  - packages/engine/src/views/desk.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/test/db/story-pr-replaces.test.ts
  - packages/engine/test/db/story-prs.test.ts
  - packages/engine/test/engine/loop-office.ts
  - packages/engine/test/engine/review-loop.ci.test.ts
  - packages/engine/test/merge-slot/
  - packages/engine/test/merge-slot/story-slot.git.test.ts
  - packages/engine/test/merge-slot/story-slot.test.ts
  - packages/engine/test/run/
  - packages/engine/test/run/conflict-resume.test.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/test/run/resume-parks.test.ts
  - packages/engine/test/story-pr/prs.test.ts
  - packages/engine/test/views/desk.test.ts
priority: high
type: feature
ordinal: 309000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo resume continues a story parked for a conflict (merge-in-progress, unwritable-path, push-rejected), refused by the merge slot (slot-refused) or whose PR was closed (stopped/pr-closed), and the merge slot's close-out removes the park field block, through the seams DIPO-155 left.

Context: DIPO-155 built the resume matrix and the seams ConflictResumer, SlotReentry, PrReplacement (packages/engine/src/run/park-resume.ts) and gitCloseOutWriter (packages/engine/src/merge-slot/close-out-park.ts); nothing implements them yet, so these parks answer resume.notResumable. DIPO-149 (conflicts of box runs, catch_ups, FixRounds.conflict) and DIPO-150 (the story merge slot) build the parts these resumes need. 0020 (the resume matrix), 0019 sections 9 and 10, 0021 (box runs).

```dipo
branch: "DIPO-324/resume-conflict-slot-pr"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) conflict/merge-in-progress resumes with the kept merge and its conflict item when the base has not moved, and merges again when it moved, recording one conflictHandoff grant"
    - kind: "automated"
      check: "(unit) conflict/push-rejected fetches the remote branch and merges it through the hand-off, never by force"
    - kind: "automated"
      check: "(unit) conflict/slot-refused returns to In Review and re-enters the merge slot with a fresh per-stay count and no model session"
    - kind: "automated"
      check: "(unit) stopped/pr-closed returns to In Review and opens a new story PR for the same head whose body names the closed one"
    - kind: "automated"
      check: "(git) the merge slot's close-out commit removes F16 in the same commit that sets Done"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 (from DIPO-155 #14) conflict/merge-in-progress continues the kept merge with its conflict item when the base has not moved and aborts and merges again when it moved, recording one conflictHandoff grant; conflict/unwritable-path merges the base again and parks at once if an unwritable path still conflicts
- [x] #2 (from DIPO-155 #15) conflict/push-rejected fetches the remote branch and merges it into the local branch through the 0019 hand-off, never by force, and the worker gets the commits that were only on the remote; conflict/slot-refused returns to In Review and re-enters the merge slot with a fresh per-stay count and no model session
- [x] #3 (from DIPO-155 #17) stopped/pr-closed returns to In Review and opens a new story PR for the same head whose body names the closed one
- [x] #4 (from DIPO-155 #25) The merge slot's close-out commit removes the F16 block through the single field write path in the same commit that sets Done, and a test shows a task file that held F16 at close-out has no park key after it
- [x] #5 The desk offers dipo resume for these parks only once they are resumable
- [x] #6 (added 2026-10-23 by the maintainer) A merge dipo commits on a story branch outside the box reaches the story's box before the worker's next session, no part is taken against a tip whose files the box lacks, and a failed copy parks the story (conflict, catch-up-failed)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23: DIPO-150 wired two of these: the close-out commit removes F16 (criterion 4) and SlotReentry re-enters a slot-refused story (half of criterion 2); check what the resume does to the run for slot-refused so re-entry takes effect.

Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all criteria met; its scope findings are closed by these References, and its advisories are fixed: the behind guard fails closed, a merge that cannot run parks, a push-rejected resume merges the remote before the session, more copy-in cases, and a reopened PR is updated). Added by the maintainer: merges dipo commits outside the box reach the box before the next session (the gap DIPO-153 found); the DIPO-153 conflict scenario is a plain it now. Migration 0052. 0019 and 0020 lines approved.
<!-- SECTION:NOTES:END -->
