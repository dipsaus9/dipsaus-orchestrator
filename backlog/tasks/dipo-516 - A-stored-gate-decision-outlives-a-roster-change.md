---
id: DIPO-516
title: Show a stored gate decision only while the roster it read is in force
status: In Progress
assignee: []
created_date: '2026-11-16 14:29'
updated_date: '2026-11-26 09:41'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - packages/engine/src/gate/hash.ts
  - packages/engine/src/views/story.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/gate-decisions/decisions.ts
  - packages/engine/src/db/migrations.ts
  - packages/engine/src/db/migrations/0016-gate-roster-hash.ts
  - packages/engine/test/views/derive.test.ts
  - docs/decisions/0012-story-standard.md
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a stored gate decision to stop showing once the role roster has changed so that the Queue never tells me to fix a role that now exists, nor shows a pass for a role that was removed.

latestGate finds a stored Ready gate decision by the story's content hash (packages/engine/src/views/story.ts:201-224, used at :251), and that hash covers story fields only (packages/engine/src/gate/hash.ts:28-48). R17 and R24 read the live roster (packages/engine/src/gate/rules.ts:441-453, :561-579; packages/engine/src/gate-decisions/feature.ts:199). When the role files on the base change, #readRoles keeps the new roster and appends roles.changed (packages/engine/src/office/manager.ts:545-552, :595-601), but every stored decision still matches its story, so the Queue keeps an R17 or R24 failure for a role that now exists.

- A roster hash in gate/hash.ts: sha256 over the canonical JSON of every role's name, kind and code flag, sorted by name.
- A new migration adds roster_hash to gate_decisions; storeGateDecision (packages/engine/src/gate-decisions/decisions.ts:79-118) writes the hash of the roster the evaluation used, in every mode and for the planning lane.
- The office database keeps the hash of the roster in force, written by the manager each time it reads the roles, so latestGate stays a read of the office database and its many callers are unchanged.
- latestGate matches only a decision whose roster_hash is the one in force. A decision stored before the migration has none and does not match.

## What it does not do
- Does not re-run the gate on a roster change; the Queue preview's live check and the next stored decision show the new verdict.
- Does not change how reconcile or the backlog PR check use passing decisions.
- Does not change the story content hash.

## ADR lines that change
- docs/decisions/0012-story-standard.md, 3. The Ready gate: "Each result is stored as a gate decision keyed on the story's content hash." becomes: Each result is stored as a gate decision keyed on the story's content hash, with the hash of the roster it read; the Queue shows it only while that roster is in force.

## Risks and choices
- other: Once the migration runs, every Refined story shows its gate as not yet checked until it is checked again, because old decisions have no roster hash.

```dipo
branch: "DIPO-516/show-stored-gate-decision-only-while"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "A Refined story with a stored R17 failure for role designer shows no failure once a designer role file lands on the base and the roles are read again"
    - kind: "automated"
      check: "A stored pass for a story with role designer no longer shows as passed once the designer role file is removed from the base"
    - kind: "automated"
      check: "Editing only a role's instructions keeps the stored decision showing"
    - kind: "automated"
      check: "A daemon restarted over the same role files shows the same stored decisions"
    - kind: "automated"
      check: "A decision row stored without a roster hash shows neither failures nor a pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every Ready gate decision stored in ready or pickup mode, and by the planning lane, keeps the hash of the roster it was evaluated with.
- [ ] #2 After the role files on the base change the roster, the story view of a Refined story whose latest decision used the old roster shows no gate failures and no pass.
- [ ] #3 A role file change that keeps every role's name, kind and code flag keeps the stored decision showing.
- [ ] #4 A daemon restart over the same role files keeps the stored decisions showing.
- [ ] #5 A decision stored before the migration, with no roster hash, shows neither failures nor a pass.
- [ ] #6 Decision 0012 says a stored gate decision keeps the hash of the roster it read and counts for the Queue only while that roster is in force.
<!-- AC:END -->
