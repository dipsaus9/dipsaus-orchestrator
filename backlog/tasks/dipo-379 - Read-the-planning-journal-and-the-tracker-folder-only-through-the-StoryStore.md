---
id: DIPO-379
title: Read the planning journal and the tracker folder only through the StoryStore
status: Refined
assignee: []
created_date: '2026-10-29 12:45'
updated_date: '2026-10-29 12:47'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/run/park-state.ts
  - packages/engine/src/story-store/
  - packages/engine/src/backlog/
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/merge/story-git.ts
  - packages/engine/src/gate/
  - packages/engine/src/office/repository.ts
priority: medium
type: chore
ordinal: 359000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no engine code outside backlog/ reads the planning journal or knows the tracker's folder name, so a store other than Backlog.md would work without touching run, box, merge or gate code.

Left by DIPO-356 part 2 (PR #432), noted by its builder and its review: run/park-state.ts still reads backlog_journal with its own SQL (about 15 call sites reach it with only an office handle), and plain `backlog/` folder checks remain outside the store: inBacklog in box/parts, box/collisions and box/lifetime, merge/story-git.ts, gate rule R12, office/repository.ts BACKLOG_CONFIG and the parts guard's protectedOf. They import nothing from backlog/, so DIPO-356's criterion 2 holds. 0010, 0004. Some of these are guards (the parts guard, collisions), so the R30 rules apply.

```dipo
branch: "DIPO-379/planning-journal-behind-store"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) park-state reads the planned park through the store"
    - kind: "automated"
      check: "(unit) each tracker-folder guard refuses the same paths and the bypass forms"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 run/park-state.ts asks the StoryStore for a story's planned park (for example StoryStore.plannedPark(office, key)), implemented in backlog/, and the direct SQL on backlog_journal outside backlog/ and retention is removed
- [ ] #2 The tracker folder name comes from one store method; inBacklog, merge/story-git.ts, gate R12, office/repository.ts and protectedOf use it, and the literal `backlog/` appears in engine code only inside backlog/
- [ ] #3 What the old barrier caught: each guard that used the literal folder (the parts guard's protectedOf, collisions) keeps refusing the same paths, with a test for each
- [ ] #4 Bypass forms are tested for each guard: ./ and ../ segments, an absolute path, a trailing slash, a different case on a case-insensitive file system, a symlink into the tracker folder, a rename into it, a folder that only shares the prefix (backlog-x/, which is not the tracker folder), and a configured folder other than backlog/
- [ ] #5 A fail-closed test against the real path: the real guard code with the real Backlog store whose folder lookup fails (not a fake store) refuses instead of allowing
<!-- AC:END -->
