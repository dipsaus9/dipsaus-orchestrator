---
id: DIPO-199
title: Name the command that frees a port slot
status: Refined
assignee: []
created_date: '2026-10-17 23:25'
updated_date: '2026-10-22 14:26'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-161
  - DIPO-197
  - DIPO-302
references:
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/worktree/setup.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/worktree/setup.test.ts
priority: medium
type: enhancement
ordinal: 188000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the slots refusal and the port slot setup failure also say that dipo discard <id> frees a story's slot, so the maintainer who reads which stories hold the slots also reads how to free one.

Context: the follow-up of DIPO-197, split from it in the review of PR #194. Tonight `dipo run DIPO-177` failed at setup because all 20 port slots were held, and the message gave no way out. DIPO-197 makes work.preview and work.run (packages/engine/src/run/work-run.ts) refuse before the claim with check slots and lists each holder in the refusal and in the setup failure (setupWorktree, packages/engine/src/worktree/setup.ts). M0 has no command that frees a slot: teardown frees it when dipo removes a worktree at Done (DIPO-58). DIPO-161 adds dipo discard <id>, which removes a story's worktree and frees its slot, so this story depends on DIPO-161 and on DIPO-197. DIPO-162's release runs on the Done poll without a command, so it is not a dependency.

```dipo
branch: "DIPO-199/slot-message-names-discard"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the slots refusal of work.preview and work.run names dipo discard <id> after the list of holders"
    - kind: "automated"
      check: "(unit) the port slot setup failure names dipo discard <id> after the list of holders"
    - kind: "manual"
      check: "(live) with a temp DIPO_HOME and worktree.maxSlots set to 1 on the scratch repo, run one story, run dipo run --dry-run for another, then dipo discard the first and run the dry run again"
      expect: "the first dry run names dipo discard <id> under the holder list, and after the discard the dry run says it would start the second story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The slots refusal of work.preview and work.run (packages/engine/src/run/work-run.ts) says, after its list of holders, that dipo discard <id> frees a story's slot; a test in packages/engine/test/run/work-run.test.ts checks the text
- [ ] #2 The port slot setup failure in setupWorktree (packages/engine/src/worktree/setup.ts) says the same after its list of holders; a test in packages/engine/test/worktree/setup.test.ts checks the text
<!-- AC:END -->
