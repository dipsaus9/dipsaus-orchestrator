---
id: DIPO-909
title: >-
  Focus: ! to the next thing for me, ' back, my place kept in every room, links in answers
status: Draft
assignee: []
created_date: '2026-11-28 10:00'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-5
dependencies:
  - DIPO-906
  - DIPO-908
references:
  - packages/tui/src/app.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/keys.ts
  - docs/design/chat-and-activity/screens/06-desk-jump-and-line.txt
  - docs/design/chat-and-activity/keymap-additions.json
priority: medium
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want one key to the next thing that needs me and one key back, so that I move between the chat, the rooms and the background without hunting or losing my place.

P6. The attention list: Desk items in engine order, background failures, chat answers not seen. The header shows `! N for you`; `!` visits them in order and marks each seen; `'` returns to where you were before the first `!` or the last link. Each room keeps its focused row, scroll and filter while the TUI runs; digits return there; a restart restores room, dock and draft. In answers, story ids, PR numbers and path:line are links (acc): tab cycles them, ⏎ opens one at its level, esc or ' comes back with the draft kept. On a QUESTION item, the `Ask dipo first` button and ` open the dock with that question.

Design: docs/design/chat-and-activity/ (screens/06-desk-jump-and-line.txt; spec.md, Focus). The mocks win; a cell difference is a bug (DIPO-900).

```dipo
branch: "DIPO-909/focus-jumps"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 06-desk-jump-and-line.txt passes expectScreen"
    - kind: "automated"
      check: "(unit) ! visits a desk item, a failed background item and an unseen answer in that order, and ' returns"
    - kind: "automated"
      check: "(unit) 3 then 2 then 3 keeps the Queue's focused row and scroll"
    - kind: "automated"
      check: "(unit) ⏎ on DIPO-116 in an answer opens its story and esc returns with the draft"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The header shows ! N for you and ! visits the list in spec.md's order
- [ ] #2 ' returns to the place before the last jump or link
- [ ] #3 Each room keeps focus, scroll and filter; a restart restores room, dock and draft
- [ ] #4 Links in answers open with ⏎ and come back with esc or '
- [ ] #5 06-desk-jump-and-line.txt passes expectScreen
<!-- AC:END -->
