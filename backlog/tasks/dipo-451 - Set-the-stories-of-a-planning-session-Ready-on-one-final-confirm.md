---
id: DIPO-451
title: Set the stories of a planning session Ready on one final confirm
status: In Review
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 15:47'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-450
references:
  - packages/engine/src/backlog/pr/check.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/contract/src/office.ts
  - packages/tui/src/
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 424000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to end a planning session by confirming which of its stories go Ready, and dipo to check the gate and set them Ready itself, so that planned work can start without a hand-made backlog pull request.

M3 (0022). Needs DIPO-450.

The backlog PR check needs a stored passing gate decision for a story's content (packages/engine/src/backlog/pr/check.ts), but gate decisions are stored only at pickup, against _base (packages/engine/src/gate-decisions/feature.ts). The Ready step evaluates the gate against the story's content as filed and stores a passing decision, then sets Ready in a second backlog PR that dipo opens, never in the PR that filed the story (0012). A story that fails the gate stays Refined, and the view shows the gate's messages.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-451/planning-ready-confirm"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the Ready confirm stores a passing gate decision for each chosen story's filed content and sets them Ready in a second backlog PR; a story that fails the gate is listed with the gate's messages and stays Refined"
    - kind: "manual"
      check: "On the scratch repository, end a planning session by confirming its two stories Ready"
      expect: "A second dipo backlog PR sets them Ready after the filing PR merged, with no hand step"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 At the end of a session the maintainer chooses which of its stories go Ready, through a command the planning view sends
- [x] #2 dipo evaluates the gate against each chosen story's filed content and stores a passing gate decision for it
- [x] #3 Stories that pass are set Ready in a second backlog PR that dipo opens, never in the PR that filed them
- [x] #4 A story that fails the gate stays Refined, and the view shows the gate's messages
- [x] #5 ADR 0012 describes setting Ready from a planning session, with one Replaced line
<!-- AC:END -->
