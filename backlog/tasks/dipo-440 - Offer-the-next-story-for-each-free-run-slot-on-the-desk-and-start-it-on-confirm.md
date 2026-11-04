---
id: DIPO-440
title: >-
  Offer the next story for each free run slot on the desk and start it on
  confirm
status: Refined
assignee: []
created_date: '2026-11-04 12:24'
labels:
  - 'tier:L'
milestone: m-2
dependencies:
  - DIPO-439
references:
  - packages/contract/src/office.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/overview/desk-notify.ts
  - packages/engine/src/records/select.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/backlog/plain.ts
  - packages/engine/src/box/collisions.ts
  - packages/cli/src/office-commands.ts
  - packages/tui/src/desk.tsx
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/how-dipo-works.md
priority: high
type: feature
ordinal: 413000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to put a next-up item on my desk, with a notification, whenever a run slot frees up, so that I decide what gets built next without typing a run for every story.

M2 goal (0003, maintainer's planning interview 2026-11-04). Blocks M2. Needs DIPO-439.

The maintainer's choices: dipo proposes, the maintainer confirms each one; one item per free slot; on decline dipo offers the next story at once; shown in dipo desk and the desk view with a notification now, only in the TUI later; ordered by the earliest open milestone, then priority; likely file overlap shown so the maintainer decides; no overlap check while stories run. The name is "next up", because "proposal" already means a worker's follow-up proposal (packages/engine/src/run/proposals.ts).

What exists to build on:
- Desk kinds are the open enum KNOWN_DESK_KINDS in packages/contract/src/office.ts; groups and ranks are in packages/engine/src/overview/desk.ts. A new kind gets the desk notification for free through DeskNotifier (packages/engine/src/overview/desk-notify.ts).
- Confirm commands to copy: proposal.accept and proposal.dismiss, gate.approve and gate.reject (contract office.ts).
- Story order: packages/engine/src/records/select.ts sorts Ready stories by priority, ordinal and id and skips stories with a dependency not Done. The milestone is parsed (packages/engine/src/backlog/plain.ts) but not used; milestone list gives done and total per milestone.
- Overlap: the story's references are its forecast of files (0012 F8). overlappingPaths in packages/engine/src/box/collisions.ts compares paths, and storyChangedFiles reads a running story's changed files.

M2 closes with the manual entry below.

```dipo
branch: "DIPO-440/next-up-for-each-free-slot"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) next-up tests: a free slot with Ready stories gives one item for the first story by earliest open milestone, then priority, ordinal and id; a story with a dependency not Done is never offered"
    - kind: "automated"
      check: "(unit) next-up tests: confirm starts the story; decline removes the item and offers the next story; a declined story comes back only after its task file changed"
    - kind: "automated"
      check: "(unit) desk tests: the next-up item lists the files its references share with running stories, and the notifier posts once per item"
    - kind: "manual"
      check: "On the scratch repository with the limit at 3 and at least three Ready stories, confirm three next-up items one by one"
      expect: "Three stories run at the same time, each in its own box, and all three merge without any dipo run typed by hand"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a run slot is free and a Ready story can start, dipo puts one next-up item per free slot on the desk, naming the story and one line of why
- [ ] #2 Stories are offered in this order: Ready stories of the earliest milestone that still has open stories, then priority, ordinal and id; a story with a dependency not Done is never offered
- [ ] #3 The item lists the files its references share with the references or changed files of running stories, or says it shares none
- [ ] #4 A confirm command starts the offered story through the same start path as dipo run; a decline command removes the item and dipo offers the next story at once
- [ ] #5 A declined story is not offered again until its task file changes or the maintainer starts it by hand
- [ ] #6 Nothing starts without a confirm, and with no startable Ready story there is no item
- [ ] #7 The item shows in dipo desk and the TUI desk view, and the desk notification posts once for it
- [ ] #8 ADR 0010 describes next up as how a free slot gets its story, and docs/how-dipo-works.md mentions it
<!-- AC:END -->
