---
id: DIPO-197
title: Check port slots in the dry run and name what holds them
status: Ready
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-18 08:09'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/worktree/slots.ts
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/test/worktree/slots.test.ts
  - packages/engine/test/worktree/setup.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run-command.test.ts
priority: high
type: bug
ordinal: 186000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when every port slot is taken, `dipo run --dry-run` and `dipo run` both refuse before a claim, and the message lists each held slot with its office, story and worktree, so the maintainer is not told a story would start and then sees setup fail without knowing what holds the slots.

Context: tonight `dipo run DIPO-177` failed at setup with "every port slot from 1 to 20 is taken by another worktree" (SetupFailure in setupWorktree, packages/engine/src/worktree/setup.ts). dipo held 20 locked worktrees and claims for stories that are Done on main through branches finished by hand. Releasing those claims is DIPO-162; this story covers two gaps beyond it:
(a) `dipo run --dry-run` printed "would start DIPO-177" (packages/cli/src/run-command.ts) while the real run failed at setup. work.preview (preview in packages/engine/src/run/work-run.ts) mirrors work.run's refusals, but slots are taken only in setup, after the claim.
(b) The failure names no holder. The machine-wide slot table (SlotTable, packages/engine/src/worktree/slots.ts) stores office, story and worktree for each slot, and drops an entry whose worktree directory is gone only when it next writes.
M0 has no command that frees a slot. Naming dipo discard <id> in these messages waits for DIPO-161 and is DIPO-199, split from this story in the review of PR #194, so this story has no dependency. Refusal checks in work.preview are open strings, so a new check needs no contract change.

```dipo
branch: "DIPO-197/port-slots-in-dry-run"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with every slot held by other live worktrees, work.preview and work.run return a slots refusal listing each holder, and with one slot free work.preview names the story it would start"
    - kind: "automated"
      check: "(unit) a story whose own worktree already holds a slot is not refused"
    - kind: "automated"
      check: "(unit) the slot read skips an entry whose worktree directory is gone and leaves the table file unchanged"
    - kind: "automated"
      check: "(unit) the setup failure message lists each holder with its slot, office, story and worktree"
    - kind: "manual"
      check: "(live) with a temp DIPO_HOME and worktree.maxSlots set to 1 on the scratch repo, run one story, then run dipo run --dry-run for another"
      expect: "the dry run prints the slots refusal naming the first story's slot, office and worktree, and does not say would start"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SlotTable (packages/engine/src/worktree/slots.ts) has a read-only method that returns the live entries, those whose worktree directory exists, without writing the table; a test in packages/engine/test/worktree/slots.test.ts shows it skips an entry whose directory is gone and leaves the file unchanged
- [ ] #2 work.preview and work.run (packages/engine/src/run/work-run.ts) refuse with check slots, before any claim, when every slot from 1 to worktree.maxSlots is held by a live worktree other than the chosen story's own; a story whose worktree already holds a slot is not refused; tests in packages/engine/test/run/work-run.test.ts show both
- [ ] #3 The slots refusal and the setup failure in setupWorktree (packages/engine/src/worktree/setup.ts) list each held slot with its number, office, story and worktree path; a test in packages/engine/test/worktree/setup.test.ts checks the setup message
- [ ] #4 dipo run --dry-run prints the slots refusal and not would start when it is refused; a test in packages/cli/src/run-command.test.ts shows it
<!-- AC:END -->
