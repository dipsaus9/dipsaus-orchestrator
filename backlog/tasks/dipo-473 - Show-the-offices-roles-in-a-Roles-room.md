---
id: DIPO-473
title: Show the office's roles in a Roles room
status: In Review
assignee: []
created_date: '2026-11-10 15:04'
updated_date: '2026-11-13 11:43'
labels:
  - 'tier:M'
milestone: m-4
dependencies:
  - DIPO-471
references:
  - packages/contract/src/office.ts
  - packages/engine/src/roles/
  - packages/engine/src/overview/
  - packages/tui/src/app.tsx
  - packages/tui/src/mode.ts
  - packages/tui/src/mode.test.ts
  - packages/tui/src/keys.ts
  - packages/tui/src/views.tsx
  - packages/tui/src/header.test.ts
  - packages/tui/src/home.tsx
  - packages/tui/src/roles.tsx
  - packages/tui/src/retro.tsx
type: feature
ordinal: 446000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a Roles room that lists my office's roles with their purpose, model, effort and instructions so that I can see who is on the team and which role files are broken.

The roster comes from the role files on the base (DIPO-471). An invalid file is left out of it and raises a notice. Nothing shows the roster today. The maintainer decided (planning 2026-11-10) on a Roles room, with the roles chat inside it; the chat is a later story. The maintainer decided (planning 2026-11-12) that the room takes key 6, because key 5 opens the planning view since DIPO-479, and that the rooms band lists 5 Plan and 6 Roles. Where the test plan says key 5 for the Roles room, read key 6.

Engine and contract:
- A new read, office.roles, next to office.retro (packages/contract/src/office.ts:1155). It returns each roster role (name, purpose, model and effort when set, instructions) and each role file that failed to load (path and problem), in name order. It reads the roster the office already holds and does no git read of its own.
- The office stream carries a change when the roster changes on the base, so an open room refreshes.

TUI:
- A new mode, roles, in packages/tui/src/mode.ts. The global key 6 opens it from home and from the retro room, next to 5 for the planning view and 4 for the retro room (packages/tui/src/app.tsx:300-301). Esc goes back home. A room key leaves it as it leaves the retro room (leavesOverlay, packages/tui/src/home.tsx:177; app.tsx:302-305). The command palette and the keys overlay open over it, as they do over the retro room (Back, mode.ts:23).
- NAV_KEYS (packages/tui/src/keys.ts:942-949) gains 6 Roles, so the palette's GO TO and the keys overlay list it.
- The rooms band (ROOMS, packages/tui/src/views.tsx:297-302; roomsText at 320) gains 5 Plan and 6 Roles after 4 Retro, without counts. The Roles room shows the band with Roles marked as the current room, as the other rooms are marked.
- The left side lists the roles: name, purpose, and model and effort, or 'tier' when the role leaves them to the tier. Invalid files are listed below the roles, marked, each with its problem.
- The right side shows the selected role's instructions, scrollable, as the retro room scrolls.
- With no role files it says the office has no roles and that dipo office init seeds the developer role.

The room is read-only in this story. The reviewer, planner, auditor and scanner are engine code and are not listed.

```dipo
branch: "DIPO-473/show-office-s-roles-roles-room"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "office.roles on an office with two valid role files and one invalid file returns the two roles and the invalid file with its problem."
    - kind: "automated"
      check: "The mode reducer goes from home to the Roles room on key 5 and back on Esc."
    - kind: "automated"
      check: "The rendered Roles room shows each role's name, purpose and model or tier, the invalid file with its problem, and the selected role's instructions."
    - kind: "automated"
      check: "A roster change event refreshes an open Roles room."
    - kind: "manual"
      check: "Open the Roles room in an office seeded with the developer role and one hand-made broken role file."
      expect: "The developer role shows with its purpose and instructions, and the broken file shows marked, with a problem that names it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 office.roles returns every role loaded from the base's role files with its name, purpose, instructions, and its model and effort when set.
- [x] #2 office.roles returns each role file that failed to load with its path and its problem.
- [x] #3 Key 6 opens the Roles room from home and from the retro room, and Esc goes back home.
- [x] #4 The command palette and the keys overlay list the Roles room with key 6.
- [x] #5 The rooms band reads 1 Desk, 2 Floor, 3 Queue, 4 Retro, 5 Plan and 6 Roles, and marks Roles as the current room while the Roles room is open.
- [x] #6 The Roles room lists each role with its purpose and its model and effort, or says it uses the tier's.
- [x] #7 The Roles room lists each invalid role file, marked, with its problem.
- [x] #8 The selected role's instructions show beside the list and scroll when they are longer than the screen.
- [x] #9 After a role file changes on the base, an open Roles room shows the new roster without being reopened.
- [x] #10 An office with no role files shows that it has no roles and names dipo office init.
<!-- AC:END -->
