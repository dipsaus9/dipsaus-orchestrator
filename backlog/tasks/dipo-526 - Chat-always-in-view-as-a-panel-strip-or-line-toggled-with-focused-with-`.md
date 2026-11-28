---
id: DIPO-526
title: 'Chat: always in view as a panel, strip or line, toggled with \, focused with `'
status: Refined
assignee: []
created_date: '2026-11-28 14:11'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-5
dependencies:
  - DIPO-520
  - DIPO-521
  - DIPO-523
references:
  - packages/tui/src/frame.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/roles.tsx
  - packages/tui/src/retro.tsx
  - packages/tui/src/keys.ts
  - docs/design/chat-and-activity/keymap-additions.json
priority: high
type: feature
ordinal: 487000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the chat always in view and aware of what I'm on, without it taking my keys, so that asking dipo never means leaving my work.

P1, P6, P7. The chat is on by default in every room and \ toggles it (remembered per viewer). Where the room keeps its own minimum width beside it (spec.md P7: Desk, Floor, reader and Roles 98, Run 96, Queue and Retro 112) it is the right 56 columns (08-desk-chat-panel.txt); from 100 columns up to that a two-row strip above the ticker (09-queue-chat-strip.txt) that ` grows to the dock (01-queue-with-dock.txt); below 100, or while hidden, the one-row chat line. The room keeps the keyboard: the chat's input is dim until ` moves the keyboard to it (acc input, cursor, the chat's footer; 05-run-with-dock-wide.txt), and esc gives it back. ` twice or 5 opens Chat full screen. The panel's context line follows the room's focus; `ask about this` lists questions code builds from the item's kind and sends nothing until one is picked. Retro's d and the Roles room's c move the keyboard to the chat with their context. keymap.json gains the entries of keymap-additions.json. The draft survives every step and a restart.

Design: docs/design/chat-and-activity/ (screens/08-desk-chat-panel.txt, 09-queue-chat-strip.txt, 01-queue-with-dock.txt, 02-chat-room.txt, 05-run-with-dock-wide.txt, 07-states.txt C5 and C6; keymap-additions.json; spec.md What the chat is for). The mocks win; a cell difference is a bug (DIPO-520).

```dipo
branch: "DIPO-526/chat-everywhere"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 08-desk-chat-panel.txt, 09-queue-chat-strip.txt, 01-queue-with-dock.txt, 02-chat-room.txt and 05-run-with-dock-wide.txt pass expectScreen"
    - kind: "automated"
      check: "(unit) with the chat shown, y on a MERGE item approves and types nothing in the chat; after ` it types y; esc gives the keys back"
    - kind: "automated"
      check: "(unit) the Desk shows the panel at 154 columns and the strip at 153, the Queue at 168 and 167, every room the line at 99; the hide key survives a restart"
    - kind: "automated"
      check: "(unit) keymap.json holds every entry of keymap-additions.json and footer.test reads them"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The chat is on by default in every room and \ shows and hides it; the choice is remembered
- [ ] #2 The panel shows where the room keeps its minimum width beside 56 columns, the strip from 100 columns up to that, the chat line below 100
- [ ] #3 The room keeps the keyboard until ` moves it to the chat; the input is dim without it and acc with it; esc gives it back
- [ ] #4 ` twice or 5 opens Chat full screen; the draft survives every step and a restart
- [ ] #5 The context line follows the room's focus and ask about this sends nothing until a question is picked
- [ ] #6 Retro's d and Roles' c move the keyboard to the chat with their context
- [ ] #7 The five screens pass expectScreen and keymap.json carries the new keys
<!-- AC:END -->
