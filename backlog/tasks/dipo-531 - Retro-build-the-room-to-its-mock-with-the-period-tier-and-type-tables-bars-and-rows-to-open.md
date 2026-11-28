---
id: DIPO-531
title: >-
  Retro: build the room to its mock, with the period, tier and type tables, bars
  and rows to open
status: Refined
assignee: []
created_date: '2026-11-28 14:11'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-520
references:
  - packages/tui/src/retro.tsx
  - packages/engine/src/overview/retro.ts
  - packages/contract/src/office.ts
  - packages/tui/src/keys.ts
  - docs/design/tui-v2/screens/06-retro.txt
  - docs/design/tui-v2/spec.md
  - docs/design/chat-and-activity/spec.md
priority: high
type: feature
ordinal: 492000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Retro room to show the office's results as the design lays them out, with periods, tables, bars and the stories behind each number, so that I can see at a glance how to prepare work better and open what lies behind a number.

Replaces DRAFT-21 (archive it when this is filed). Today the room renders office.retro as a scrolling list of text lines (retro.tsx: `lines: string[]`); DIPO-463 closed with its criterion 6 (follow S2c) unchecked. Build tui-v2/screens/06-retro.txt cell for cell: the three headline numbers (bold hi value, dim label), BY TIER (stories, cost/st, rounds, loops, Ready→merged; a value twice the median in err; the focused row on sel), WHY STORIES PARKED and WHERE STORIES CAME FROM as acc `━` bars with the small rest faint and dim, the period `7d  30d  all` at the right of the rooms row (←→), `tab` for BY TIER and BY TYPE, ⏎ for the stories behind a row (a list that opens the story reader). office.retro returns these as data per period instead of text lines; the counting stays the engine's. `d` hands the numbers to the chat with the Retro context (chat-and-activity spec.md P9); until DIPO-526 it keeps opening a planning session with them as today. Rework and "Worth a look" stay out (decision 26).

```dipo
branch: "DIPO-531/retro-room"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 06-retro.txt passes expectScreen whole for the 30d period"
    - kind: "automated"
      check: "(unit) a tier value twice the median shows in err, and a value below it does not"
    - kind: "automated"
      check: "(unit) the arrow keys move between 7d, 30d and all and the numbers follow the period"
    - kind: "automated"
      check: "(unit) tab switches the table to BY TYPE and back"
    - kind: "automated"
      check: "(unit) Enter on the L row lists its stories and Enter on one opens the story reader"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 office.retro returns the headline numbers, the tier and type rows, the park reasons and the origins per period as data, counted by the engine
- [ ] #2 The room matches 06-retro.txt cell for cell, roles included, with a value twice the median in err
- [ ] #3 The period switch sits on the rooms row and the arrow keys change it; tab switches tier and type
- [ ] #4 Enter on a row lists the stories behind it, and Enter on one opens it in the story reader
- [ ] #5 d hands the period's numbers to a planning session today and to the chat once DIPO-526 is done
- [ ] #6 DRAFT-21 is archived with a pointer to this story
<!-- AC:END -->
